/* Game Boy emulator for the web client: mGBA's GB core, driven one frame at a
 * time from JavaScript, with the link port exposed as a clock-master byte
 * exchange (the same model as the GB-Link adapter and the BGB transport). */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#include <mgba/core/blip_buf.h>
#include <mgba/core/core.h>
#include <mgba/core/log.h>
#include <mgba/gb/core.h>
#include <mgba/internal/gb/gb.h>
#include <mgba/internal/gb/io.h>
#include <mgba/internal/gb/renderers/software.h>
#include <mgba/internal/gb/sio.h>
#include <mgba/internal/sm83/sm83.h>
#include <mgba-util/vfs.h>

#define VIDEO_STRIDE 256
#define VIDEO_MAX_HEIGHT 224
#define AUDIO_BUFFER_SAMPLES 4096
#define LINK_WAIT_FRAMES 1
#define LINK_NOT_READY 0x100
#define SCREEN_X 48
#define SCREEN_Y 40
#define BORDER_CAPTURE_FRAMES 600
#define BORDER_SETTLE_FRAMES 30

static struct mCore* core = NULL;
static void* romData = NULL;
static size_t romLength = 0;
static color_t videoBuffer[VIDEO_STRIDE * VIDEO_MAX_HEIGHT];
static int16_t audioOut[AUDIO_BUFFER_SAMPLES * 2];
static int audioRate = 48000;
static void* saveCopy = NULL;
static size_t saveCopySize = 0;
static bool preferSgb = false;
static bool sgbBorder = false;
/* Border of a Game Boy Color game that also supports the Super Game Boy, drawn
 * around its own screen: 0 not captured yet, 1 captured, -1 none */
static int borderState = 0;
static color_t borderImage[VIDEO_STRIDE * VIDEO_MAX_HEIGHT];
static bool borderOverScreen = false;
static bool borderShown = false;

static void _noLog(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	(void) logger; (void) category; (void) level; (void) format; (void) args;
}
static struct mLogger quietLogger = { .log = _noLog };

struct LinkDriver {
	struct GBSIODriver d;
	struct mTimingEvent done;
	int pending;
	int pendingFrames;
	int result;
	bool transferring;
	uint8_t gameByte;
	uint8_t inByte;
};
static struct LinkDriver gbLink;

static struct GB* _gb(void) {
	return core ? (struct GB*) core->board : NULL;
}

static bool _armedAsFollower(struct GB* gb, uint8_t sc) {
	(void) gb;
	return GBRegisterSCIsEnable(sc) && !GBRegisterSCIsShiftClock(sc);
}

static void _linkDone(struct mTiming* timing, void* context, uint32_t cyclesLate) {
	(void) timing; (void) cyclesLate;
	struct LinkDriver* l = context;
	struct GB* gb = l->d.p->p;
	l->transferring = false;
	gb->memory.io[GB_REG_SB] = l->inByte;
	gb->memory.io[GB_REG_SC] = GBRegisterSCClearEnable(gb->memory.io[GB_REG_SC]);
	gb->memory.io[GB_REG_IF] |= (1 << GB_IRQ_SIO);
	GBUpdateIRQs(gb);
	l->result = l->gameByte;
}

static void _linkStart(struct LinkDriver* l) {
	struct GB* gb = l->d.p->p;
	l->gameByte = gb->memory.io[GB_REG_SB];
	l->inByte = (uint8_t) l->pending;
	l->pending = -1;
	l->transferring = true;
	mTimingDeschedule(&gb->timing, &l->done);
	mTimingSchedule(&gb->timing, &l->done, 8 * GBSIOCyclesPerTransfer[0] * (2 - gb->doubleSpeed));
}

static bool _linkInit(struct GBSIODriver* driver) {
	struct LinkDriver* l = (struct LinkDriver*) driver;
	l->pending = -1;
	l->result = -1;
	l->transferring = false;
	return true;
}

static void _linkDeinit(struct GBSIODriver* driver) {
	struct LinkDriver* l = (struct LinkDriver*) driver;
	if (l->transferring && l->d.p) {
		mTimingDeschedule(&l->d.p->p->timing, &l->done);
	}
	l->transferring = false;
}

static void _linkWriteSB(struct GBSIODriver* driver, uint8_t value) {
	(void) driver; (void) value;
}

static uint8_t _linkWriteSC(struct GBSIODriver* driver, uint8_t value) {
	struct LinkDriver* l = (struct LinkDriver*) driver;
	struct GB* gb = l->d.p->p;
	if (!GBRegisterSCIsEnable(value)) {
		if (l->transferring) {
			mTimingDeschedule(&gb->timing, &l->done);
			l->transferring = false;
			l->result = LINK_NOT_READY;
		}
	} else if (GBRegisterSCIsShiftClock(value)) {
		// The game drives the clock: nobody answers, like the BGB transport
		l->d.p->pendingSB = 0x00;
	} else if (l->pending >= 0 && !l->transferring) {
		_linkStart(l);
	}
	return value;
}

static uint32_t _hashBytes(uint32_t hash, const uint8_t* data, size_t size) {
	for (size_t i = 0; i < size; ++i) {
		hash = (hash ^ data[i]) * 16777619u;
	}
	return hash;
}

/* The border as a Super Game Boy draws it; over the screen only where the
 * border covers it (0 elsewhere). */
static void _drawBorderImage(struct GBVideoRenderer* renderer) {
	const uint8_t* chr = renderer->sgbCharRam;
	const uint8_t* map = renderer->sgbMapRam;
	color_t backdrop = ((struct GBVideoSoftwareRenderer*) renderer)->palette[0];
	color_t palette[0x40];
	for (int i = 0; i < 0x40; ++i) {
		uint16_t color;
		LOAD_16LE(color, 0x800 + i * 2, map);
		palette[i] = ((i & 0xF) ? mColorFrom555(color) : backdrop) | 0xFF000000;
	}
	borderOverScreen = false;
	for (int y = 0; y < VIDEO_MAX_HEIGHT; ++y) {
		for (int x = 0; x < VIDEO_STRIDE; x += 8) {
			bool screen = x >= SCREEN_X && x < SCREEN_X + GB_VIDEO_HORIZONTAL_PIXELS && y >= SCREEN_Y && y < SCREEN_Y + GB_VIDEO_VERTICAL_PIXELS;
			color_t* out = &borderImage[y * VIDEO_STRIDE + x];
			uint16_t entry;
			LOAD_16LE(entry, (x >> 2) + (y & ~7) * 8, map);
			unsigned tile = SGBBgAttributesGetTile(entry);
			if (tile >= 0x100) {
				for (int i = 0; i < 8; ++i) {
					out[i] = screen ? 0 : 0xFF000000;
				}
				continue;
			}
			const uint8_t* data = &chr[(tile * 16 + ((y & 7) ^ (SGBBgAttributesIsYFlip(entry) ? 7 : 0))) * 2];
			int base = (SGBBgAttributesGetPalette(entry) & 3) * 0x10;
			for (int i = 0; i < 8; ++i) {
				int bit = 7 - i;
				int index = (data[0] >> bit & 1) | (data[1] >> bit & 1) << 1 | (data[0x10] >> bit & 1) << 2 | (data[0x11] >> bit & 1) << 3;
				out[SGBBgAttributesIsXFlip(entry) ? 7 - i : i] = screen && !index ? 0 : palette[base | index];
				borderOverScreen |= screen && index;
			}
		}
	}
}

/* Games that also run on a Game Boy Color (Gold, Silver) send their border only
 * to a Super Game Boy, so a second copy boots as one until the border is in. */
static void _captureBorder(void) {
	borderState = -1;
	struct VFile* vf = VFileFromConstMemory(romData, romLength);
	struct mCore* sgb = vf ? GBCoreCreate() : NULL;
	if (!sgb) {
		if (vf) {
			vf->close(vf);
		}
		return;
	}
	mCoreInitConfig(sgb, NULL);
	sgb->init(sgb);
	mCoreConfigSetDefaultValue(&sgb->config, "idleOptimization", "ignore");
	mCoreConfigSetDefaultValue(&sgb->config, "cgb.sgbModel", "SGB");
	mCoreConfigSetDefaultIntValue(&sgb->config, "sgb.borders", 1);
	mCoreConfigSetDefaultIntValue(&sgb->config, "useBios", 0);
	mCoreLoadConfig(sgb);
	sgb->setVideoBuffer(sgb, borderImage, VIDEO_STRIDE);
	sgb->setAudioBufferSize(sgb, AUDIO_BUFFER_SAMPLES);
	if (sgb->loadROM(sgb, vf)) {
		sgb->loadSave(sgb, VFileMemChunk(NULL, 0));
		sgb->reset(sgb);
		struct GB* gb = sgb->board;
		struct GBVideoRenderer* renderer = gb->video.renderer;
		uint8_t* first = malloc(SGB_SIZE_MAP_RAM);
		if (first && (gb->model & GB_MODEL_SGB)) {
			memcpy(first, renderer->sgbMapRam, SGB_SIZE_MAP_RAM);
			uint32_t last = 0;
			int settled = 0;
			for (int frame = 0; frame < BORDER_CAPTURE_FRAMES && borderState < 0; ++frame) {
				sgb->runFrame(sgb);
				blip_clear(sgb->getAudioChannel(sgb, 0));
				blip_clear(sgb->getAudioChannel(sgb, 1));
				// The game's border is in once its tile map has replaced mGBA's and nothing changes for a while
				if (!memcmp(first, renderer->sgbMapRam, SGB_SIZE_MAP_RAM)) {
					continue;
				}
				uint32_t hash = _hashBytes(_hashBytes(2166136261u, renderer->sgbCharRam, SGB_SIZE_CHAR_RAM), renderer->sgbMapRam, SGB_SIZE_MAP_RAM);
				settled = hash == last ? settled + 1 : 0;
				last = hash;
				if (settled >= BORDER_SETTLE_FRAMES) {
					_drawBorderImage(renderer);
					borderState = 1;
				}
			}
		}
		free(first);
	}
	sgb->unloadROM(sgb);
	mCoreConfigDeinit(&sgb->config);
	sgb->deinit(sgb);
}

static void _drawBorder(int fromY, int toY) {
	for (int i = fromY * VIDEO_STRIDE; i < toY * VIDEO_STRIDE; ++i) {
		if (borderImage[i]) {
			videoBuffer[i] = borderImage[i];
		}
	}
}

/* Moves the picture into (or out of) the middle of the captured border. */
static void _showBorder(bool show) {
	if (show == borderShown) {
		return;
	}
	color_t* screen = &videoBuffer[SCREEN_Y * VIDEO_STRIDE + SCREEN_X];
	if (show) {
		for (int y = GB_VIDEO_VERTICAL_PIXELS - 1; y >= 0; --y) {
			memmove(&screen[y * VIDEO_STRIDE], &videoBuffer[y * VIDEO_STRIDE], GB_VIDEO_HORIZONTAL_PIXELS * sizeof(color_t));
		}
		_drawBorder(0, VIDEO_MAX_HEIGHT);
		core->setVideoBuffer(core, screen, VIDEO_STRIDE);
	} else {
		for (int y = 0; y < GB_VIDEO_VERTICAL_PIXELS; ++y) {
			memmove(&videoBuffer[y * VIDEO_STRIDE], &screen[y * VIDEO_STRIDE], GB_VIDEO_HORIZONTAL_PIXELS * sizeof(color_t));
		}
		core->setVideoBuffer(core, videoBuffer, VIDEO_STRIDE);
	}
	borderShown = show;
}

/* Super Game Boy games draw their own border; the others get the captured one. */
static void _updateBorder(void) {
	struct GB* gb = _gb();
	if (!gb || (gb->model & GB_MODEL_SGB)) {
		return;
	}
	if (sgbBorder && !borderState && (GBValidModels(romData) & GB_MODEL_SGB)) {
		_captureBorder();
	}
	_showBorder(sgbBorder && borderState > 0);
}

EMSCRIPTEN_KEEPALIVE void emu_set_sample_rate(int rate) {
	audioRate = rate > 0 ? rate : 48000;
	if (core) {
		blip_set_rates(core->getAudioChannel(core, 0), core->frequency(core), audioRate);
		blip_set_rates(core->getAudioChannel(core, 1), core->frequency(core), audioRate);
	}
}

EMSCRIPTEN_KEEPALIVE void emu_unload(void) {
	if (!core) {
		return;
	}
	core->unloadROM(core);
	mCoreConfigDeinit(&core->config);
	core->deinit(core);
	core = NULL;
	free(romData);
	romData = NULL;
	romLength = 0;
	borderState = 0;
	borderShown = false;
}

EMSCRIPTEN_KEEPALIVE void* emu_alloc(size_t size) {
	return malloc(size);
}

EMSCRIPTEN_KEEPALIVE void emu_free(void* ptr) {
	free(ptr);
}

/* Takes ownership of rom (from emu_alloc); save may be NULL. The save buffer is
 * copied. Returns 0 on success. */
EMSCRIPTEN_KEEPALIVE int emu_load(void* rom, size_t romSize, const void* save, size_t saveSize) {
	emu_unload();
	mLogSetDefaultLogger(&quietLogger);
	romData = rom;
	romLength = romSize;
	struct VFile* vf = VFileFromMemory(romData, romSize);
	if (!vf) {
		free(romData);
		romData = NULL;
		return 1;
	}
	core = GBCoreCreate();
	if (!core || !core->isROM(vf)) {
		vf->close(vf);
		free(core);
		core = NULL;
		free(romData);
		romData = NULL;
		return 2;
	}
	mCoreInitConfig(core, NULL);
	core->init(core);
	mCoreConfigSetDefaultValue(&core->config, "idleOptimization", "ignore");
	mCoreConfigSetDefaultIntValue(&core->config, "sgb.borders", sgbBorder);
	if (preferSgb) {
		/* Games that also run on a Game Boy Color (Yellow) start as on a Super Game Boy */
		mCoreConfigSetDefaultValue(&core->config, "cgb.sgbModel", "SGB");
	}
	mCoreConfigSetDefaultIntValue(&core->config, "useBios", 0);
	mCoreConfigSetDefaultIntValue(&core->config, "volume", 0x100);
	mCoreLoadConfig(core);
	core->setVideoBuffer(core, videoBuffer, VIDEO_STRIDE);
	core->setAudioBufferSize(core, AUDIO_BUFFER_SAMPLES);
	if (!core->loadROM(core, vf)) {
		mCoreConfigDeinit(&core->config);
		core->deinit(core);
		core = NULL;
		free(romData);
		romData = NULL;
		return 3;
	}
	struct VFile* sv = VFileMemChunk(save, save ? saveSize : 0);
	core->loadSave(core, sv);
	emu_set_sample_rate(audioRate);

	memset(&gbLink, 0, sizeof(gbLink));
	gbLink.d.init = _linkInit;
	gbLink.d.deinit = _linkDeinit;
	gbLink.d.writeSB = _linkWriteSB;
	gbLink.d.writeSC = _linkWriteSC;
	gbLink.done.context = &gbLink;
	gbLink.done.name = "GB-Link transfer";
	gbLink.done.callback = _linkDone;
	gbLink.done.priority = 0x31;
	GBSIOSetDriver(&_gb()->sio, &gbLink.d);

	core->reset(core);
	_updateBorder();
	return 0;
}

EMSCRIPTEN_KEEPALIVE void emu_reset(void) {
	if (core) {
		core->reset(core);
	}
}

/* Applies from the next emu_load. */
EMSCRIPTEN_KEEPALIVE void emu_set_prefer_sgb(int on) {
	preferSgb = on != 0;
}

EMSCRIPTEN_KEEPALIVE void emu_set_sgb_border(int on) {
	sgbBorder = on != 0;
	if (core) {
		mCoreConfigSetIntValue(&core->config, "sgb.borders", sgbBorder);
		core->reloadConfigOption(core, "sgb.borders", NULL);
		_updateBorder();
	}
}

EMSCRIPTEN_KEEPALIVE int emu_is_sgb(void) {
	struct GB* gb = _gb();
	return gb && (gb->model & GB_MODEL_SGB) ? 1 : 0;
}

/* 1 when the game has a Super Game Boy border to show. */
EMSCRIPTEN_KEEPALIVE int emu_has_border(void) {
	struct GB* gb = _gb();
	if (!gb) {
		return 0;
	}
	if (gb->model & GB_MODEL_SGB) {
		return 1;
	}
	return borderState >= 0 && (GBValidModels(romData) & GB_MODEL_SGB) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void emu_set_keys(int keys) {
	if (core) {
		core->setKeys(core, (uint32_t) keys);
	}
}

/* Runs one frame; returns the frame counter. */
EMSCRIPTEN_KEEPALIVE int emu_frame(void) {
	if (!core) {
		return -1;
	}
	core->runFrame(core);
	unsigned width = GB_VIDEO_HORIZONTAL_PIXELS, height = GB_VIDEO_VERTICAL_PIXELS;
	color_t* screen = &videoBuffer[SCREEN_Y * VIDEO_STRIDE + SCREEN_X];
	if (!borderShown) {
		screen = videoBuffer;
		core->desiredVideoDimensions(core, &width, &height);
	}
	for (unsigned y = 0; y < height; ++y) {
		color_t* row = &screen[y * VIDEO_STRIDE];
		for (unsigned x = 0; x < width; ++x) {
			row[x] |= 0xFF000000;
		}
	}
	if (borderShown && borderOverScreen) {
		_drawBorder(SCREEN_Y, SCREEN_Y + GB_VIDEO_VERTICAL_PIXELS);
	}
	if (gbLink.pending >= 0 && ++gbLink.pendingFrames >= LINK_WAIT_FRAMES) {
		gbLink.pending = -1;
		gbLink.result = LINK_NOT_READY;
	}
	return (int) core->frameCounter(core);
}

EMSCRIPTEN_KEEPALIVE color_t* emu_video(void) {
	return videoBuffer;
}

EMSCRIPTEN_KEEPALIVE int emu_video_width(void) {
	unsigned width = 160, height = 144;
	if (borderShown) {
		return VIDEO_STRIDE;
	}
	if (core) {
		core->desiredVideoDimensions(core, &width, &height);
	}
	return (int) width;
}

EMSCRIPTEN_KEEPALIVE int emu_video_height(void) {
	unsigned width = 160, height = 144;
	if (borderShown) {
		return VIDEO_MAX_HEIGHT;
	}
	if (core) {
		core->desiredVideoDimensions(core, &width, &height);
	}
	return (int) height;
}

EMSCRIPTEN_KEEPALIVE int emu_video_stride(void) {
	return VIDEO_STRIDE;
}

/* Interleaved stereo samples; returns the number of sample frames written. */
EMSCRIPTEN_KEEPALIVE int emu_audio(void) {
	if (!core) {
		return 0;
	}
	blip_t* left = core->getAudioChannel(core, 0);
	blip_t* right = core->getAudioChannel(core, 1);
	int avail = blip_samples_avail(left);
	if (avail > AUDIO_BUFFER_SAMPLES) {
		avail = AUDIO_BUFFER_SAMPLES;
	}
	int produced = blip_read_samples(left, audioOut, avail, true);
	blip_read_samples(right, audioOut + 1, avail, true);
	return produced;
}

EMSCRIPTEN_KEEPALIVE int16_t* emu_audio_buffer(void) {
	return audioOut;
}

/* Copies the battery save; read it from emu_save_data(). */
EMSCRIPTEN_KEEPALIVE int emu_save_size(void) {
	free(saveCopy);
	saveCopy = NULL;
	saveCopySize = 0;
	if (!core) {
		return 0;
	}
	saveCopySize = core->savedataClone(core, &saveCopy);
	return (int) saveCopySize;
}

EMSCRIPTEN_KEEPALIVE void* emu_save_data(void) {
	return saveCopy;
}

EMSCRIPTEN_KEEPALIVE int emu_read8(int address) {
	return core ? (int) core->busRead8(core, (uint32_t) address) : -1;
}

EMSCRIPTEN_KEEPALIVE int emu_raw_read8(int address, int segment) {
	return core ? (int) core->rawRead8(core, (uint32_t) address, segment) : -1;
}

EMSCRIPTEN_KEEPALIVE void emu_write8(int address, int value) {
	if (core) {
		core->busWrite8(core, (uint32_t) address, (uint8_t) value);
	}
}

EMSCRIPTEN_KEEPALIVE int emu_cpu_pc(void) {
	return core ? ((struct SM83Core*) core->cpu)->pc : -1;
}

EMSCRIPTEN_KEEPALIVE int emu_cpu_sp(void) {
	return core ? ((struct SM83Core*) core->cpu)->sp : -1;
}

/* Clock-master byte exchange: the byte is delivered when the game arms its
 * port as the follower; emu_link_result() is -1 while pending, the game's byte
 * when done, LINK_NOT_READY when the game did not arm within the wait. */
EMSCRIPTEN_KEEPALIVE void emu_link_send(int byte) {
	struct GB* gb = _gb();
	if (!gb) {
		gbLink.result = LINK_NOT_READY;
		return;
	}
	gbLink.result = -1;
	gbLink.pending = byte & 0xFF;
	gbLink.pendingFrames = 0;
	if (!gbLink.transferring && _armedAsFollower(gb, gb->memory.io[GB_REG_SC])) {
		_linkStart(&gbLink);
	}
}

EMSCRIPTEN_KEEPALIVE int emu_link_result(void) {
	int result = gbLink.result;
	if (result >= 0) {
		gbLink.result = -1;
	}
	return result;
}
