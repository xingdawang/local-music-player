const audio = document.querySelector("#audio");
const folderInput = document.querySelector("#folderInput");
const playlistEl = document.querySelector("#playlist");
const trackCountEl = document.querySelector("#trackCount");
const playModeLabel = document.querySelector("#playModeLabel");
const searchInput = document.querySelector("#searchInput");
const trackTitle = document.querySelector("#trackTitle");
const trackArtist = document.querySelector("#trackArtist");
const lyricsStage = document.querySelector("#lyricsStage");
const lyricsEl = document.querySelector("#lyrics");
const trackArtwork = document.querySelector("#trackArtwork");
const recordFrame = document.querySelector(".record-frame");
const tonearm = document.querySelector(".tonearm");
const currentTimeEl = document.querySelector("#currentTime");
const durationEl = document.querySelector("#duration");
const progress = document.querySelector("#progress");
const touchProgress = document.querySelector("#touchProgress");
const touchProgressFill = document.querySelector("#touchProgressFill");
const touchProgressThumb = document.querySelector("#touchProgressThumb");
const prevButton = document.querySelector("#prevButton");
const playButton = document.querySelector("#playButton");
const nextButton = document.querySelector("#nextButton");
const playModeButton = document.querySelector("#playModeButton");
const playerPanel = document.querySelector(".player-panel");
const appShell = document.querySelector(".app-shell");
const openLibraryButton = document.querySelector("#openLibraryButton");
const closeLibraryButton = document.querySelector("#closeLibraryButton");
const collapseLibraryButton = document.querySelector("#collapseLibraryButton");
const expandLibraryButton = document.querySelector("#expandLibraryButton");
const libraryScrim = document.querySelector("#libraryScrim");

const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "wav", "m4a", "ogg", "aac"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const AUDIO_MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  aac: "audio/aac",
};
const desktopArtworkQuery = window.matchMedia("(min-width: 821px)");
const mobileLayoutQuery = window.matchMedia("(max-width: 820px)");
const PLAYBACK_STATE_KEY = "localMusicPlayer.playbackState";
const LIBRARY_COLLAPSED_KEY = "localMusicPlayer.libraryCollapsed";

let tracks = [];
let currentIndex = -1;
let lyrics = [];
let activeLyricIndex = -1;
let isSeeking = false;
let playMode = "loop";
let playHistory = [];
let historyCursor = -1;
let currentArtworkObjectUrl = null;
let pendingSeekTime = null;
let lastStateSaveAt = 0;
let isTouchSeeking = false;
let searchQuery = "";
let lyricSelectionIndex = -1;
let lyricSelectionTimer = null;
let isProgrammaticLyricScroll = false;
let mobileSwipeStart = null;
let didMobileSwipe = false;

const MOBILE_SWIPE_MIN_DISTANCE = 64;
const MOBILE_SWIPE_MAX_VERTICAL_DRIFT = 70;
const MOBILE_SWIPE_DOMINANCE_RATIO = 1.35;

const DEFAULT_THEME = {
  pageBgTop: "#5f756a",
  pageBgMid: "#26312c",
  pageBgBottom: "#111614",
  accent: "#8ecab5",
  accentSoft: "#dff4ec",
  accentStrong: "#356f5b",
};


function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function rgbToCss(color) {
  return `rgb(${clampChannel(color.r)}, ${clampChannel(color.g)}, ${clampChannel(color.b)})`;
}

function rgbToHsl(color) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === r) {
    hue = (g - b) / delta + (g < b ? 6 : 0);
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }

  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToRgb(hue, saturation, lightness) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));

  if (s === 0) {
    const value = clampChannel(l * 255);
    return { r: value, g: value, b: value };
  }

  const hueToRgb = (p, q, t) => {
    let adjusted = t;
    if (adjusted < 0) adjusted += 1;
    if (adjusted > 1) adjusted -= 1;
    if (adjusted < 1 / 6) return p + (q - p) * 6 * adjusted;
    if (adjusted < 1 / 2) return q;
    if (adjusted < 2 / 3) return p + (q - p) * (2 / 3 - adjusted) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: clampChannel(hueToRgb(p, q, h + 1 / 3) * 255),
    g: clampChannel(hueToRgb(p, q, h) * 255),
    b: clampChannel(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function applyTheme(theme = DEFAULT_THEME) {
  const root = document.documentElement;
  root.style.setProperty("--page-bg-top", theme.pageBgTop);
  root.style.setProperty("--page-bg-mid", theme.pageBgMid);
  root.style.setProperty("--page-bg-bottom", theme.pageBgBottom);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-soft", theme.accentSoft);
  root.style.setProperty("--accent-strong", theme.accentStrong);
}

function resetTheme() {
  applyTheme(DEFAULT_THEME);
}

function extractArtworkPalette(image) {
  const width = 48;
  const height = 48;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const buckets = new Map();
  let averageR = 0;
  let averageG = 0;
  let averageB = 0;
  let averageCount = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 120) continue;

    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    averageR += r;
    averageG += g;
    averageB += b;
    averageCount += 1;

    const hsl = rgbToHsl({ r, g, b });
    const lightness = hsl.l;
    const saturation = hsl.s;

    if (lightness < 0.08 || lightness > 0.94 || saturation < 0.08) continue;

    const bucketKey = [r, g, b].map((value) => Math.round(value / 24) * 24).join(",");
    const bucket = buckets.get(bucketKey) || { r: 0, g: 0, b: 0, count: 0, score: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    bucket.score += 0.18 + saturation * 3.4 + (0.5 - Math.abs(lightness - 0.46)) * 0.85;
    buckets.set(bucketKey, bucket);
  }

  if (!averageCount) return null;

  let dominantBucket = null;
  for (const bucket of buckets.values()) {
    if (!dominantBucket || bucket.score > dominantBucket.score) {
      dominantBucket = bucket;
    }
  }

  if (dominantBucket && dominantBucket.count) {
    return {
      r: dominantBucket.r / dominantBucket.count,
      g: dominantBucket.g / dominantBucket.count,
      b: dominantBucket.b / dominantBucket.count,
    };
  }

  return {
    r: averageR / averageCount,
    g: averageG / averageCount,
    b: averageB / averageCount,
  };
}

function updateThemeFromArtwork(image) {
  try {
    if (!(image instanceof HTMLImageElement) || !image.complete || !image.naturalWidth) {
      resetTheme();
      return;
    }

    const dominant = extractArtworkPalette(image);
    if (!dominant) {
      resetTheme();
      return;
    }

    const dominantHsl = rgbToHsl(dominant);
    if (dominantHsl.s < 0.08) {
      resetTheme();
      return;
    }

    const hue = dominantHsl.h;
    const saturation = Math.min(0.84, Math.max(0.46, dominantHsl.s * 1.06));
    const top = hslToRgb(hue, saturation, 0.4);
    const mid = hslToRgb(hue, Math.min(0.78, saturation * 0.96), 0.22);
    const bottom = hslToRgb(hue + 4, Math.min(0.72, saturation * 0.9), 0.11);
    const accent = hslToRgb(hue, Math.min(0.82, saturation * 1.02), 0.62);
    const accentSoft = hslToRgb(hue, Math.min(0.52, saturation * 0.42), 0.88);
    const accentStrong = hslToRgb(hue, Math.min(0.82, saturation), 0.3);

    applyTheme({
      pageBgTop: rgbToCss(top),
      pageBgMid: rgbToCss(mid),
      pageBgBottom: rgbToCss(bottom),
      accent: rgbToCss(accent),
      accentSoft: rgbToCss(accentSoft),
      accentStrong: rgbToCss(accentStrong),
    });
  } catch {
    resetTheme();
  }
}

function swingTonearm() {
  tonearm.classList.remove("is-swinging");
  void tonearm.offsetWidth;
  tonearm.classList.add("is-swinging");
}

function openMobileLyrics() {
  if (!mobileLayoutQuery.matches) return;
  playerPanel.classList.add("mobile-lyrics-open");
}

function closeMobileLyrics() {
  playerPanel.classList.remove("mobile-lyrics-open");
}

function shouldIgnoreMobileSwipe(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;

  return Boolean(
    target.closest(
      "button, input, textarea, select, a, .touch-progress, .controls, .library-panel, .library-scrim, .lyric-seek-button",
    ),
  );
}

function resetMobileSwipe() {
  mobileSwipeStart = null;
}

function startMobileSwipe(event) {
  if (!mobileLayoutQuery.matches) return;
  if (event.pointerType && event.pointerType !== "touch" && event.pointerType !== "pen") return;
  if (shouldIgnoreMobileSwipe(event)) return;

  mobileSwipeStart = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
}

function finishMobileSwipe(event) {
  if (!mobileSwipeStart || event.pointerId !== mobileSwipeStart.pointerId) return;

  const deltaX = event.clientX - mobileSwipeStart.x;
  const deltaY = event.clientY - mobileSwipeStart.y;
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  resetMobileSwipe();

  const isHorizontalSwipe =
    horizontalDistance >= MOBILE_SWIPE_MIN_DISTANCE &&
    verticalDistance <= MOBILE_SWIPE_MAX_VERTICAL_DRIFT &&
    horizontalDistance / Math.max(verticalDistance, 1) >= MOBILE_SWIPE_DOMINANCE_RATIO;

  if (!isHorizontalSwipe || !tracks.length) return;

  didMobileSwipe = true;
  event.preventDefault();
  event.stopPropagation();

  if (deltaX < 0) {
    nextTrack(true, { silentNotAllowed: true });
  } else {
    previousSong(true, { silentNotAllowed: true });
  }
}

function getExtension(fileName) {
  return fileName.split(".").pop().toLowerCase();
}

function sniffAudioMime(bytes) {
  const text = String.fromCharCode(...bytes.slice(0, 16));

  if (text.startsWith("ID3") || bytes[0] === 0xff) return "audio/mpeg";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("RIFF")) return "audio/wav";
  if (text.startsWith("OggS")) return "audio/ogg";
  if (text.includes("ftyp")) return "audio/mp4";
  return null;
}

async function createAudioObjectUrl(file) {
  const extension = getExtension(file.name);
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const mimeType = sniffAudioMime(header) || AUDIO_MIME_BY_EXTENSION[extension] || file.type || "audio/mpeg";
  const typedBlob = file.slice(0, file.size, mimeType);
  return URL.createObjectURL(typedBlob);
}

function baseName(fileName) {
  return fileName.replace(/\.[^/.]+$/, "");
}

function parseTrackName(name) {
  const normalized = baseName(name);
  const [artist, ...titleParts] = normalized.split(" - ");
  if (!titleParts.length) {
    return { artist: "Unknown Artist", title: normalized };
  }
  return { artist, title: titleParts.join(" - ") };
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function updateProgressUi() {
  const duration = audio.duration || 0;
  const value = Number.isFinite(duration) && duration > 0 ? Math.round((audio.currentTime / duration) * 1000) : 0;
  progress.value = value;
  touchProgress.setAttribute("aria-valuenow", String(value));
  touchProgressFill.style.width = `${value / 10}%`;
  touchProgressThumb.style.left = `${value / 10}%`;
}

function seekToRatio(ratio, shouldSave = true) {
  const duration = audio.duration || 0;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const clampedRatio = Math.min(1, Math.max(0, ratio));
  audio.currentTime = clampedRatio * duration;
  currentTimeEl.textContent = formatTime(audio.currentTime);
  updateProgressUi();
  updateActiveLyric();
  if (shouldSave) savePlaybackState();
  updateMediaSessionPosition();
}

function seekFromTouchProgressEvent(event, shouldSave = true) {
  const rect = touchProgress.getBoundingClientRect();
  if (!rect.width) return;
  seekToRatio((event.clientX - rect.left) / rect.width, shouldSave);
}

function formatLyricTime(seconds) {
  return formatTime(seconds);
}

function clearLyricSelectionTimer() {
  if (!lyricSelectionTimer) return;
  clearTimeout(lyricSelectionTimer);
  lyricSelectionTimer = null;
}

function setLyricSelection(index) {
  if (!lyrics[index]) return;
  if (lyricSelectionIndex !== -1 && lyricSelectionIndex !== index) {
    lyricsEl.querySelector(`[data-index="${lyricSelectionIndex}"]`)?.classList.remove("selected");
  }
  lyricSelectionIndex = index;
  lyricsEl.querySelector(`[data-index="${index}"]`)?.classList.add("selected");
}

function clearLyricSelection() {
  if (lyricSelectionIndex !== -1) {
    lyricsEl.querySelector(`[data-index="${lyricSelectionIndex}"]`)?.classList.remove("selected");
  }
  lyricSelectionIndex = -1;
  clearLyricSelectionTimer();
}

function scrollActiveLyricIntoView() {
  const activeLine = lyricsEl.querySelector(`[data-index="${activeLyricIndex}"]`);
  if (!activeLine) return;
  isProgrammaticLyricScroll = true;
  activeLine.scrollIntoView({ block: "center", behavior: "smooth" });
  window.setTimeout(() => {
    isProgrammaticLyricScroll = false;
  }, 650);
}

function scheduleReturnToActiveLyric() {
  clearLyricSelectionTimer();
  lyricSelectionTimer = window.setTimeout(() => {
    clearLyricSelection();
    scrollActiveLyricIntoView();
  }, 3000);
}

function selectLyricNearCenter() {
  if (isProgrammaticLyricScroll || !lyrics.length) return;

  const containerRect = lyricsEl.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;
  const lines = Array.from(lyricsEl.querySelectorAll(".lyric-line"));
  let closestIndex = -1;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    const lineCenter = rect.top + rect.height / 2;
    const distance = Math.abs(lineCenter - centerY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = Number(line.dataset.index);
    }
  }

  if (closestIndex === -1) return;
  setLyricSelection(closestIndex);
  scheduleReturnToActiveLyric();
}

function normalizeSearchText(text) {
  return text
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function trackSearchText(track) {
  return normalizeSearchText([track.title, track.artist, track.name, track.searchText].filter(Boolean).join(" "));
}

function matchesSearch(track) {
  if (!searchQuery) return true;
  return trackSearchText(track).includes(searchQuery);
}

function getTrackKey(track) {
  return track?.name || track?.audioUrl || track?.audioFile?.name || null;
}

function readPlaybackState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_STATE_KEY) || "null");
    if (!saved || typeof saved !== "object") return null;
    return saved;
  } catch {
    return null;
  }
}

function savePlaybackState() {
  if (currentIndex < 0 || !tracks[currentIndex]) return;

  const trackKey = getTrackKey(tracks[currentIndex]);
  if (!trackKey) return;

  localStorage.setItem(
    PLAYBACK_STATE_KEY,
    JSON.stringify({
      trackKey,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      playMode,
      savedAt: Date.now(),
    }),
  );
}

function savePlaybackStateSoon() {
  const now = Date.now();
  if (now - lastStateSaveAt < 1000) return;
  lastStateSaveAt = now;
  savePlaybackState();
}

function setMediaSessionAction(action, handler) {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Some browsers expose Media Session but do not support every action.
  }
}

function mediaArtworkUrl(track) {
  const artworkUrl = track?.imageUrl || "./favicon.png";
  return new URL(artworkUrl, window.location.href).href;
}

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window) || currentIndex < 0 || !tracks[currentIndex]) return;

  const track = tracks[currentIndex];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: "Local Music Player",
    artwork: [
      { src: mediaArtworkUrl(track), sizes: "96x96" },
      { src: mediaArtworkUrl(track), sizes: "256x256" },
      { src: mediaArtworkUrl(track), sizes: "512x512" },
    ],
  });
}

function updateMediaSessionPosition() {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime || 0, audio.duration),
    });
  } catch {
    // Ignore position updates when the platform rejects transient values.
  }
}

function updateMediaSessionPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  setMediaSessionAction("play", () => {
    swingTonearm();
    startPlayback();
  });
  setMediaSessionAction("pause", () => {
    swingTonearm();
    audio.pause();
  });
  setMediaSessionAction("previoustrack", () => previousSong(true));
  setMediaSessionAction("nexttrack", () => nextTrack(true));
  setMediaSessionAction("seekto", (details) => {
    if (!Number.isFinite(details.seekTime)) return;
    audio.currentTime = details.seekTime;
    updateActiveLyric();
    savePlaybackState();
    updateMediaSessionPosition();
  });
}

function shouldIgnoreShortcut(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "slider") return true;

  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}

function togglePlayMode() {
  playMode = playMode === "shuffle" ? "loop" : "shuffle";
  savePlaybackState();
  updateButtons();
}

async function togglePlayback() {
  if (!tracks.length) return;
  swingTonearm();
  if (currentIndex === -1) await loadTrack(0);

  if (audio.paused) {
    await startPlayback();
  } else {
    audio.pause();
  }
}

function parseLrc(text) {
  const parsed = [];
  const linePattern = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;

  for (const rawLine of text.split(/\r?\n/)) {
    linePattern.lastIndex = 0;
    const matches = [...rawLine.matchAll(linePattern)];
    if (!matches.length) continue;

    const lyricText = matches[matches.length - 1][4].trim() || " ";
    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = Number((match[3] || "0").padEnd(3, "0"));
      parsed.push({
        time: minutes * 60 + seconds + fraction / 1000,
        text: lyricText,
      });
    }
  }

  return parsed.sort((a, b) => a.time - b.time);
}

function renderPlaylist() {
  playlistEl.innerHTML = "";

  const visibleTracks = tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => matchesSearch(track));

  visibleTracks.forEach(({ track, index }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = track.playable === false;
    button.className = `track-item${index === currentIndex ? " active" : ""}${track.playable === false ? " unsupported" : ""}`;
    button.innerHTML = `
      <span>
        <span class="track-name">${track.title}</span>
        <span class="track-subtitle">${track.artist}</span>
      </span>
      <span class="track-badge">${track.playable === false ? "Unsupported" : track.lyricFile || track.lyricUrl ? "LRC" : track.extension.toUpperCase()}</span>
    `;
    button.addEventListener("click", () => {
      closeLibraryDrawer();
      loadTrack(index, true);
    });
    playlistEl.appendChild(button);
  });

  if (tracks.length && !visibleTracks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-search";
    empty.textContent = "No matching songs.";
    playlistEl.appendChild(empty);
  }

  if (!tracks.length) {
    trackCountEl.textContent = "No songs loaded";
  } else if (searchQuery) {
    trackCountEl.textContent = `${visibleTracks.length} of ${tracks.length} songs`;
  } else {
    trackCountEl.textContent = `${tracks.length} songs loaded`;
  }
}

function openLibraryDrawer() {
  appShell.classList.add("library-drawer-open");
  openLibraryButton.setAttribute("aria-expanded", "true");
}

function closeLibraryDrawer() {
  appShell.classList.remove("library-drawer-open");
  openLibraryButton.setAttribute("aria-expanded", "false");
}

function setLibraryCollapsed(isCollapsed, shouldSave = true) {
  appShell.classList.toggle("library-collapsed", isCollapsed);
  collapseLibraryButton.setAttribute("aria-expanded", String(!isCollapsed));
  expandLibraryButton.setAttribute("aria-expanded", String(!isCollapsed));
  if (shouldSave) {
    localStorage.setItem(LIBRARY_COLLAPSED_KEY, isCollapsed ? "true" : "false");
  }
}

function restoreLibraryCollapsed() {
  setLibraryCollapsed(localStorage.getItem(LIBRARY_COLLAPSED_KEY) === "true", false);
}

function renderLyrics() {
  lyricsEl.innerHTML = "";
  activeLyricIndex = -1;
  clearLyricSelection();

  if (!lyrics.length) {
    const line = document.createElement("p");
    line.className = "lyric-line active";
    line.textContent = "No lyric file found for this song.";
    lyricsEl.appendChild(line);
    return;
  }

  lyrics.forEach((lyric, index) => {
    const line = document.createElement("div");
    line.className = `lyric-line${index === 0 ? " active" : ""}`;
    line.dataset.index = index;
    line.innerHTML = `
      <span class="lyric-time">${formatLyricTime(lyric.time)}</span>
      <span class="lyric-text">${lyric.text}</span>
      <button class="lyric-seek-button" type="button" aria-label="Play from ${formatLyricTime(lyric.time)}">
        <span aria-hidden="true"></span>
      </button>
    `;
    line.querySelector(".lyric-seek-button").addEventListener("click", (event) => {
      event.stopPropagation();
      clearLyricSelection();
      audio.currentTime = lyric.time;
      currentTimeEl.textContent = formatTime(audio.currentTime);
      updateProgressUi();
      updateActiveLyric();
      updateMediaSessionPosition();
      savePlaybackState();
      startPlayback();
    });
    lyricsEl.appendChild(line);
  });

  activeLyricIndex = 0;
}

async function loadLyrics(track) {
  if (track.lyricUrl) {
    const response = await fetch(track.lyricUrl);
    const text = response.ok ? await response.text() : "";
    lyrics = parseLrc(text);
    renderLyrics();
    return;
  }

  if (!track.lyricFile) {
    lyrics = [];
    renderLyrics();
    return;
  }

  const text = await track.lyricFile.text();
  lyrics = parseLrc(text);
  renderLyrics();
}

function clearArtwork() {
  trackArtwork.removeAttribute("src");
  lyricsStage.classList.remove("has-artwork");
  playerPanel.classList.remove("has-artwork");
  resetTheme();

  if (currentArtworkObjectUrl) {
    URL.revokeObjectURL(currentArtworkObjectUrl);
    currentArtworkObjectUrl = null;
  }
}

function artworkUrlFromMediaUrl(mediaUrl) {
  if (!mediaUrl) return "";
  const url = new URL(mediaUrl, window.location.href);
  if (url.pathname !== "/api/media") return "";
  const fileName = url.searchParams.get("file");
  if (!fileName) return "";
  return `/api/artwork?file=${encodeURIComponent(fileName)}`;
}

async function loadArtwork(track) {
  clearArtwork();
  if (!track) return;

  let artworkUrl = track.imageUrl || artworkUrlFromMediaUrl(track.audioUrl);
  if (!artworkUrl && track.imageFile) {
    currentArtworkObjectUrl = URL.createObjectURL(track.imageFile);
    artworkUrl = currentArtworkObjectUrl;
  }
  if (!artworkUrl) return;

  trackArtwork.src = artworkUrl;
  lyricsStage.classList.add("has-artwork");
  playerPanel.classList.add("has-artwork");

  if (trackArtwork.complete && trackArtwork.naturalWidth) {
    updateThemeFromArtwork(trackArtwork);
  }
}

function recordHistory(index) {
  if (historyCursor >= 0 && playHistory[historyCursor] === index) return;

  playHistory = playHistory.slice(0, historyCursor + 1);
  playHistory.push(index);
  historyCursor = playHistory.length - 1;
}

async function loadTrack(index, shouldPlay = false, options = {}) {
  if (!tracks[index]) return;
  if (tracks[index].playable === false) return;
  const { record = true, seekTime = null, silentNotAllowed = false } = options;

  if (tracks[currentIndex]?.objectUrl) {
    URL.revokeObjectURL(tracks[currentIndex].objectUrl);
  }

  currentIndex = index;
  if (record) recordHistory(index);
  pendingSeekTime = Number.isFinite(seekTime) && seekTime > 0 ? seekTime : null;

  const track = tracks[currentIndex];
  if (track.audioUrl) {
    audio.src = track.audioUrl;
  } else {
    track.objectUrl = await createAudioObjectUrl(track.audioFile);
    audio.src = track.objectUrl;
  }
  audio.load();
  trackTitle.textContent = track.title;
  trackArtist.textContent = track.artist;
  progress.value = 0;
  updateProgressUi();
  currentTimeEl.textContent = "0:00";
  durationEl.textContent = "0:00";

  if (shouldPlay) {
    await startPlayback({ silentNotAllowed });
  } else if (pendingSeekTime === null) {
    savePlaybackState();
  }

  await loadArtwork(track);
  await loadLyrics(track);
  renderPlaylist();
  updateMediaSessionMetadata();
  updateButtons();
}

async function startPlayback(options = {}) {
  if (!tracks.length) return false;
  const { silentNotAllowed = false } = options;

  try {
    await audio.play();
    return true;
  } catch (error) {
    const isNotAllowedError = error?.name === "NotAllowedError";
    if (!silentNotAllowed || !isNotAllowedError) {
      trackArtist.textContent = isNotAllowedError
        ? "Tap Play once to allow playback on this browser."
        : `Playback failed: ${error.message}`;
    }
    updateButtons();
    return false;
  }
}

function updateButtons() {
  const hasTracks = tracks.length > 0;
  playButton.disabled = !hasTracks;
  prevButton.disabled = !hasTracks;
  nextButton.disabled = !hasTracks;
  playButton.title = audio.paused ? "Play" : "Pause";
  playButton.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  const isShuffle = playMode === "shuffle";
  playModeButton.title = isShuffle ? "Random play" : "Repeat playlist";
  playModeButton.setAttribute("aria-label", isShuffle ? "Random play" : "Repeat playlist");
  playModeButton.querySelector(".control-label").textContent = isShuffle ? "Random" : "Repeat";
  playModeButton.classList.toggle("is-active", isShuffle);
  playModeLabel.textContent = isShuffle ? "Random" : "Repeat";
  playerPanel.classList.toggle("is-playing", !audio.paused);
  updateMediaSessionPlaybackState();
}

function updateActiveLyric() {
  if (!lyrics.length) return;

  const now = audio.currentTime;
  let nextIndex = lyrics.findIndex((line, index) => {
    const nextLine = lyrics[index + 1];
    return now >= line.time && (!nextLine || now < nextLine.time);
  });

  if (nextIndex === -1) nextIndex = 0;
  if (nextIndex === activeLyricIndex) return;

  lyricsEl.querySelector(".lyric-line.active")?.classList.remove("active");
  const activeLine = lyricsEl.querySelector(`[data-index="${nextIndex}"]`);
  activeLine?.classList.add("active");
  activeLyricIndex = nextIndex;
  if (lyricSelectionIndex === -1) {
    scrollActiveLyricIntoView();
  }
}

function randomNextIndex() {
  const playableIndexes = tracks
    .map((track, index) => (track.playable === false ? null : index))
    .filter((index) => index !== null);
  if (playableIndexes.length <= 1) return currentIndex;

  let next = currentIndex;
  while (next === currentIndex) {
    next = playableIndexes[Math.floor(Math.random() * playableIndexes.length)];
  }
  return next;
}

function nextTrack(shouldPlay = true, options = {}) {
  if (!tracks.length) return;
  swingTonearm();

  if (historyCursor < playHistory.length - 1) {
    historyCursor += 1;
    loadTrack(playHistory[historyCursor], shouldPlay, { record: false, ...options });
    return;
  }

  let nextIndex = playMode === "shuffle" ? randomNextIndex() : (currentIndex + 1) % tracks.length;
  while (tracks[nextIndex]?.playable === false && nextIndex !== currentIndex) {
    nextIndex = (nextIndex + 1) % tracks.length;
  }
  loadTrack(nextIndex, shouldPlay, options);
}

function previousSong(shouldPlay = true, options = {}) {
  if (!tracks.length) return;
  swingTonearm();

  if (historyCursor > 0) {
    historyCursor -= 1;
    loadTrack(playHistory[historyCursor], shouldPlay, { record: false, ...options });
    return;
  }

  let previousIndex = currentIndex <= 0 ? tracks.length - 1 : currentIndex - 1;
  while (tracks[previousIndex]?.playable === false && previousIndex !== currentIndex) {
    previousIndex = previousIndex <= 0 ? tracks.length - 1 : previousIndex - 1;
  }
  loadTrack(previousIndex, shouldPlay, options);
}

function previousTrack() {
  if (!tracks.length) return;
  swingTonearm();
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    savePlaybackState();
    updateMediaSessionPosition();
    return;
  }

  previousSong(true);
}

function buildTracksFromFiles(files) {
  const fileList = Array.from(files);
  const lrcByBaseName = new Map();
  const imageByBaseName = new Map();

  for (const file of fileList) {
    if (getExtension(file.name) === "lrc") {
      lrcByBaseName.set(baseName(file.name), file);
    } else if (IMAGE_EXTENSIONS.has(getExtension(file.name))) {
      imageByBaseName.set(baseName(file.name), file);
    }
  }

  return fileList
    .filter((file) => AUDIO_EXTENSIONS.has(getExtension(file.name)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((audioFile) => {
      const parsed = parseTrackName(audioFile.name);
      return {
        ...parsed,
        name: audioFile.name,
        searchText: `${parsed.artist} ${parsed.title} ${audioFile.name}`,
        audioFile,
        lyricFile: lrcByBaseName.get(baseName(audioFile.name)),
        imageFile: imageByBaseName.get(baseName(audioFile.name)),
        extension: getExtension(audioFile.name),
        objectUrl: null,
      };
    });
}

function normalizeRemoteTrack(track) {
  return {
    artist: track.artist || "Unknown Artist",
    title: track.title || track.name || "Unknown Title",
    name: track.name || track.audioUrl || track.title || "Unknown Track",
    searchText: track.searchText || [track.artist, track.title, track.name].filter(Boolean).join(" "),
    audioUrl: track.audioUrl,
    lyricUrl: track.lyricUrl || null,
    imageUrl: track.imageUrl || null,
    extension: track.extension || getExtension(track.name || track.audioUrl || "mp3"),
    playable: track.playable !== false,
    objectUrl: null,
  };
}

async function loadRemoteLibrary(libraryUrl, sourceLabel) {
  try {
    const response = await fetch(libraryUrl);
    if (!response.ok) return false;

    const payload = await response.json();
    if (!Array.isArray(payload.tracks) || !payload.tracks.length) return false;

    tracks = payload.tracks.map(normalizeRemoteTrack);
    currentIndex = -1;
    playHistory = [];
    historyCursor = -1;

    const savedState = readPlaybackState();
    if (savedState?.playMode === "shuffle" || savedState?.playMode === "loop") {
      playMode = savedState.playMode;
    }

    const firstPlayableIndex = tracks.findIndex((track) => track.playable !== false);
    const savedIndex = tracks.findIndex((track) => getTrackKey(track) === savedState?.trackKey);
    const initialIndex = savedIndex === -1 ? firstPlayableIndex : savedIndex;
    await loadTrack(initialIndex === -1 ? 0 : initialIndex, false, {
      record: false,
      seekTime: savedIndex === -1 ? null : Number(savedState?.currentTime),
    });
    const unsupportedCount = tracks.filter((track) => track.playable === false).length;
    trackCountEl.textContent = unsupportedCount
      ? `${tracks.length} songs loaded, ${unsupportedCount} unsupported`
      : `${tracks.length} songs loaded from ${sourceLabel}`;
    return true;
  } catch {
    return false;
  }
}

async function loadServerLibrary() {
  return (await loadRemoteLibrary("/api/tracks", "Converted Music")) || loadRemoteLibrary("./tracks.json", "tracks.json");
}

folderInput.addEventListener("change", async (event) => {
  tracks = buildTracksFromFiles(event.target.files);
  currentIndex = -1;
  playHistory = [];
  historyCursor = -1;
  audio.pause();
  audio.removeAttribute("src");
  clearArtwork();

  if (!tracks.length) {
    renderPlaylist();
    trackTitle.textContent = "No audio files found";
    trackArtist.textContent = "Choose a folder with MP3, FLAC, WAV, M4A, OGG or AAC files.";
    renderLyrics();
    updateButtons();
    return;
  }

  await loadTrack(0, false);
});

searchInput.addEventListener("input", () => {
  searchQuery = normalizeSearchText(searchInput.value);
  renderPlaylist();
});

playButton.addEventListener("click", togglePlayback);

prevButton.addEventListener("click", previousTrack);
nextButton.addEventListener("click", () => nextTrack(true));

playModeButton.addEventListener("click", togglePlayMode);

progress.addEventListener("input", () => {
  isSeeking = true;
  const duration = audio.duration || 0;
  currentTimeEl.textContent = formatTime((Number(progress.value) / 1000) * duration);
  touchProgress.setAttribute("aria-valuenow", progress.value);
  touchProgressFill.style.width = `${Number(progress.value) / 10}%`;
  touchProgressThumb.style.left = `${Number(progress.value) / 10}%`;
});

progress.addEventListener("change", () => {
  const duration = audio.duration || 0;
  audio.currentTime = (Number(progress.value) / 1000) * duration;
  isSeeking = false;
  updateProgressUi();
  updateActiveLyric();
  savePlaybackState();
});

touchProgress.addEventListener("pointerdown", (event) => {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  isTouchSeeking = true;
  touchProgress.setPointerCapture(event.pointerId);
  seekFromTouchProgressEvent(event, false);
});

touchProgress.addEventListener("pointermove", (event) => {
  if (!isTouchSeeking) return;
  seekFromTouchProgressEvent(event, false);
});

touchProgress.addEventListener("pointerup", (event) => {
  if (!isTouchSeeking) return;
  isTouchSeeking = false;
  touchProgress.releasePointerCapture(event.pointerId);
  seekFromTouchProgressEvent(event, true);
});

touchProgress.addEventListener("pointercancel", (event) => {
  isTouchSeeking = false;
  if (touchProgress.hasPointerCapture(event.pointerId)) {
    touchProgress.releasePointerCapture(event.pointerId);
  }
});

touchProgress.addEventListener("keydown", (event) => {
  const duration = audio.duration || 0;
  if (!Number.isFinite(duration) || duration <= 0) return;

  if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    event.preventDefault();
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    event.preventDefault();
    audio.currentTime = Math.min(duration, audio.currentTime + 5);
  } else {
    return;
  }

  currentTimeEl.textContent = formatTime(audio.currentTime);
  updateProgressUi();
  updateActiveLyric();
  savePlaybackState();
  updateMediaSessionPosition();
});

lyricsEl.addEventListener("scroll", selectLyricNearCenter, { passive: true });

playerPanel.addEventListener("pointerdown", startMobileSwipe);
playerPanel.addEventListener("pointerup", finishMobileSwipe);
playerPanel.addEventListener("pointercancel", resetMobileSwipe);

audio.addEventListener("loadedmetadata", () => {
  durationEl.textContent = formatTime(audio.duration);

  if (pendingSeekTime !== null) {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = duration > 0 ? Math.min(pendingSeekTime, Math.max(0, duration - 0.25)) : pendingSeekTime;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    updateProgressUi();
    pendingSeekTime = null;
    savePlaybackState();
  }
  updateProgressUi();
  updateMediaSessionPosition();
});

audio.addEventListener("timeupdate", () => {
  if (!isSeeking && !isTouchSeeking && Number.isFinite(audio.duration) && audio.duration > 0) {
    updateProgressUi();
  }
  currentTimeEl.textContent = formatTime(audio.currentTime);
  updateActiveLyric();
  savePlaybackStateSoon();
  updateMediaSessionPosition();
});

audio.addEventListener("play", updateButtons);
audio.addEventListener("pause", () => {
  savePlaybackState();
  updateButtons();
});
audio.addEventListener("ended", () => nextTrack(true));
trackArtwork.addEventListener("load", () => updateThemeFromArtwork(trackArtwork));
trackArtwork.addEventListener("error", clearArtwork);
tonearm.addEventListener("animationend", () => {
  tonearm.classList.remove("is-swinging");
});
recordFrame.addEventListener("click", (event) => {
  if (!mobileLayoutQuery.matches) return;
  event.stopPropagation();
  openMobileLyrics();
});
recordFrame.addEventListener("keydown", (event) => {
  if (!mobileLayoutQuery.matches) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openMobileLyrics();
});
playerPanel.addEventListener("click", () => {
  if (didMobileSwipe) {
    didMobileSwipe = false;
    return;
  }
  if (!mobileLayoutQuery.matches || !playerPanel.classList.contains("mobile-lyrics-open")) return;
  closeMobileLyrics();
});
openLibraryButton.addEventListener("click", openLibraryDrawer);
closeLibraryButton.addEventListener("click", closeLibraryDrawer);
collapseLibraryButton.addEventListener("click", () => setLibraryCollapsed(true));
expandLibraryButton.addEventListener("click", () => setLibraryCollapsed(false));
libraryScrim.addEventListener("click", closeLibraryDrawer);

document.addEventListener("keydown", (event) => {
  if (shouldIgnoreShortcut(event)) return;

  if (event.key === "Escape") {
    closeLibraryDrawer();
    return;
  }

  if (event.key === " " || event.code === "Space") {
    event.preventDefault();
    togglePlayback();
    return;
  }

  const shortcut = event.key.toLowerCase();
  if (shortcut === "p") {
    previousSong(true);
  } else if (shortcut === "n") {
    nextTrack(true);
  } else if (shortcut === "r") {
    togglePlayMode();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    savePlaybackState();
  }
});

window.addEventListener("beforeunload", savePlaybackState);

desktopArtworkQuery.addEventListener("change", () => {
  if (currentIndex === -1 || !tracks[currentIndex]) {
    clearArtwork();
    return;
  }
  loadArtwork(tracks[currentIndex]);
});

mobileLayoutQuery.addEventListener("change", () => {
  closeLibraryDrawer();
  closeMobileLyrics();
});

restoreLibraryCollapsed();
setupMediaSession();
updateButtons();
loadServerLibrary();
