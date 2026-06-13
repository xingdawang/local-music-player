from __future__ import annotations

import json
import mimetypes
import shutil
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, unquote, urlencode, urlparse
from urllib.request import Request, urlopen

from mutagen import File as MutagenFile
from mutagen.id3 import ID3, ID3NoHeaderError
from pypinyin import Style, lazy_pinyin


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MUSIC_DIR = Path("/Users/xingdawang/Music/Converted Music")
AUDIO_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".aac"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
ARTWORK_SEARCH_TIMEOUT = 8
LYRICS_SEARCH_TIMEOUT = 8
LYRICS_PROVIDER_URL = "https://lrclib.net/api/search"
DEBUG_EVENTS_LIMIT = 600
DEBUG_EVENTS: list[dict[str, object]] = []
DEBUG_EVENTS_LOCK = Lock()


class MusicPlayerHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        parsed_path = urlparse(path).path
        return str(PROJECT_ROOT / unquote(parsed_path).lstrip("/"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/tracks":
            self.send_tracks()
            return

        if parsed.path == "/api/media":
            self.send_music_file(parsed.query)
            return

        if parsed.path == "/api/artwork":
            self.send_artwork(parsed.query)
            return

        if parsed.path == "/api/lyrics":
            self.send_lyrics(parsed.query)
            return

        if parsed.path == "/api/debug-events":
            self.send_debug_events(parsed.query)
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/debug-events":
            self.receive_debug_event()
            return

        self.send_error(404, "Not found")

    def send_json(self, payload: object, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_debug_events(self, query: str) -> None:
        params = parse_qs(query)
        try:
            limit = int(params.get("limit", [DEBUG_EVENTS_LIMIT])[0])
        except ValueError:
            limit = DEBUG_EVENTS_LIMIT
        limit = max(1, min(DEBUG_EVENTS_LIMIT, limit))

        with DEBUG_EVENTS_LOCK:
            if params.get("clear", ["0"])[0] == "1":
                DEBUG_EVENTS.clear()
            events = list(DEBUG_EVENTS[-limit:])

        self.send_json({"ok": True, "count": len(events), "events": events})

    def receive_debug_event(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self.send_error(400, "Invalid Content-Length")
            return

        if content_length <= 0 or content_length > 65536:
            self.send_error(400, "Invalid debug payload")
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return

        if not isinstance(payload, dict):
            self.send_error(400, "Invalid debug event")
            return

        payload["_serverTime"] = time.time()
        with DEBUG_EVENTS_LOCK:
            DEBUG_EVENTS.append(payload)
            del DEBUG_EVENTS[:-DEBUG_EVENTS_LIMIT]
            count = len(DEBUG_EVENTS)

        self.send_json({"ok": True, "count": count})

    def send_tracks(self) -> None:
        music_dir = DEFAULT_MUSIC_DIR.expanduser().resolve()
        if not music_dir.exists():
            self.send_json({"tracks": [], "error": f"Folder does not exist: {music_dir}"}, status=404)
            return

        lrc_by_stem = {path.stem: path for path in music_dir.glob("*.lrc")}
        image_by_stem = {
            path.stem: path
            for path in music_dir.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        }
        tracks = []

        for audio_path in sorted(music_dir.iterdir(), key=lambda path: path.name.casefold()):
            if audio_path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue

            artist, title = parse_track_name(audio_path.stem)
            lyric_path = lrc_by_stem.get(audio_path.stem)
            image_path = image_by_stem.get(audio_path.stem)
            content_type = guess_music_type(audio_path)
            playable = content_type.startswith("audio/")
            image_url = f"/api/media?file={quote_path(image_path.name)}" if image_path else None
            if not image_url and has_embedded_artwork(audio_path):
                image_url = f"/api/artwork?file={quote_path(audio_path.name)}"
            if not image_url:
                image_url = f"/api/artwork?file={quote_path(audio_path.name)}"

            tracks.append(
                {
                    "artist": artist,
                    "title": title,
                    "name": audio_path.name,
                    "extension": audio_path.suffix.lower().removeprefix("."),
                    "playable": playable,
                    "contentType": content_type,
                    "audioUrl": f"/api/media?file={quote_path(audio_path.name)}",
                    "lyricUrl": f"/api/media?file={quote_path(lyric_path.name)}" if lyric_path else None,
                    "imageUrl": image_url,
                    "searchText": build_search_text(artist, title, audio_path.stem),
                }
            )

        self.send_json({"tracks": tracks, "folder": str(music_dir)})

    def send_music_file(self, query: str) -> None:
        file_names = parse_qs(query).get("file", [])
        if not file_names:
            self.send_error(400, "Missing file parameter")
            return

        music_dir = DEFAULT_MUSIC_DIR.expanduser().resolve()
        requested = (music_dir / file_names[0]).resolve()
        if music_dir not in requested.parents and requested != music_dir:
            self.send_error(403, "File is outside the music folder")
            return
        if not requested.exists() or not requested.is_file():
            self.send_error(404, "File not found")
            return

        content_type = guess_media_type(requested)
        file_size = requested.stat().st_size
        range_header = self.headers.get("Range")

        if range_header:
            self.send_music_range(requested, content_type, file_size, range_header)
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(file_size))
        self.end_headers()

        with requested.open("rb") as file:
            while chunk := file.read(1024 * 256):
                self.wfile.write(chunk)

    def send_music_range(self, path: Path, content_type: str, file_size: int, range_header: str) -> None:
        try:
            byte_range = range_header.removeprefix("bytes=").split("-", 1)
            start = int(byte_range[0] or 0)
            end = int(byte_range[1]) if byte_range[1] else file_size - 1
        except ValueError:
            self.send_error(416, "Invalid range")
            return

        start = max(0, start)
        end = min(file_size - 1, end)
        if start > end:
            self.send_error(416, "Invalid range")
            return

        content_length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(content_length))
        self.end_headers()

        with path.open("rb") as file:
            file.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self.wfile.write(chunk)

    def send_artwork(self, query: str) -> None:
        file_names = parse_qs(query).get("file", [])
        if not file_names:
            self.send_error(400, "Missing file parameter")
            return

        music_dir = DEFAULT_MUSIC_DIR.expanduser().resolve()
        requested = (music_dir / file_names[0]).resolve()
        if music_dir not in requested.parents and requested != music_dir:
            self.send_error(403, "File is outside the music folder")
            return
        if not requested.exists() or not requested.is_file():
            self.send_error(404, "File not found")
            return
        artwork = find_artwork_for_audio(requested)
        if not artwork:
            self.send_error(404, "Artwork not found")
            return

        content_type, data = artwork
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def send_lyrics(self, query: str) -> None:
        file_names = parse_qs(query).get("file", [])
        if not file_names:
            self.send_error(400, "Missing file parameter")
            return

        music_dir = DEFAULT_MUSIC_DIR.expanduser().resolve()
        requested = (music_dir / file_names[0]).resolve()
        if music_dir not in requested.parents and requested != music_dir:
            self.send_error(403, "File is outside the music folder")
            return
        if not requested.exists() or not requested.is_file() or requested.suffix.lower() not in AUDIO_EXTENSIONS:
            self.send_error(404, "File not found")
            return

        lyric_path, source = find_lyrics_for_audio(requested)
        if not lyric_path:
            self.send_json({"ok": False, "error": "Lyrics not found"}, status=404)
            return

        self.send_json(
            {
                "ok": True,
                "source": source,
                "lyricFile": lyric_path.name,
                "lyricUrl": f"/api/media?file={quote_path(lyric_path.name)}",
            }
        )


def parse_track_name(stem: str) -> tuple[str, str]:
    parts = stem.split(" - ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return "Unknown Artist", stem


def quote_path(name: str) -> str:
    from urllib.parse import quote

    return quote(name)


def local_artwork_path(audio_path: Path) -> Path | None:
    for extension in IMAGE_EXTENSIONS:
        candidate = audio_path.with_suffix(extension)
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def build_search_text(*parts: str) -> str:
    text = " ".join(part for part in parts if part)
    full_pinyin = " ".join(lazy_pinyin(text, errors="ignore"))
    compact_pinyin = full_pinyin.replace(" ", "")
    initials = "".join(lazy_pinyin(text, style=Style.FIRST_LETTER, errors="ignore"))
    search_tokens = [text.casefold(), full_pinyin.casefold(), compact_pinyin.casefold(), initials.casefold()]
    return " ".join(dict.fromkeys(token for token in search_tokens if token))


def guess_music_type(path: Path) -> str:
    with path.open("rb") as file:
        header = file.read(32)

    if header.startswith(b"ID3") or header.startswith(b"\xff"):
        return "audio/mpeg"
    if header.startswith(b"fLaC"):
        return "audio/flac"
    if header.startswith(b"RIFF"):
        return "audio/wav"
    if header.startswith(b"OggS"):
        return "audio/ogg"
    if b"ftyp" in header:
        return "audio/mp4"

    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def guess_media_type(path: Path) -> str:
    if path.suffix.lower() in AUDIO_EXTENSIONS:
        return guess_music_type(path)

    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    if path.suffix.lower() == ".lrc":
        return "text/plain; charset=utf-8"
    return "application/octet-stream"


def local_lyric_path(audio_path: Path) -> Path | None:
    candidate = audio_path.with_suffix(".lrc")
    if candidate.exists() and candidate.is_file():
        return candidate
    return None


def is_valid_lrc_text(text: str) -> bool:
    for line in text.splitlines():
        if parse_lrc_timestamped_line(line):
            return True
    return False


def is_valid_lrc_file(path: Path) -> bool:
    try:
        return is_valid_lrc_text(path.read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError:
        try:
            return is_valid_lrc_text(path.read_text(encoding="gb18030"))
        except Exception:
            return False
    except Exception:
        return False


def parse_lrc_timestamped_line(line: str) -> bool:
    index = 0
    while index < len(line):
        start = line.find("[", index)
        if start == -1:
            return False
        end = line.find("]", start + 1)
        if end == -1:
            return False
        stamp = line[start + 1 : end]
        minutes, separator, rest = stamp.partition(":")
        if separator and minutes.isdigit():
            seconds, dot, fraction = rest.partition(".")
            if seconds.isdigit() and len(seconds) == 2 and (not dot or fraction.isdigit()):
                return True
        index = end + 1
    return False


def find_lyrics_for_audio(audio_path: Path) -> tuple[Path, str] | tuple[None, None]:
    local_path = local_lyric_path(audio_path)
    if local_path and is_valid_lrc_file(local_path):
        return local_path, "local"

    downloaded_path = download_online_lyrics(audio_path)
    if downloaded_path:
        return downloaded_path, "lrclib"

    return None, None


def download_online_lyrics(audio_path: Path) -> Path | None:
    artist, title = parse_track_name(audio_path.stem)
    candidates = search_lrclib_lyrics(artist, title, audio_duration_seconds(audio_path))
    lyrics_text = select_synced_lyrics(candidates, artist, title)
    if not lyrics_text:
        return None

    target_path = audio_path.with_suffix(".lrc")
    if target_path.exists() and is_valid_lrc_file(target_path):
        return target_path

    if target_path.exists():
        try:
            backup_invalid_lyric(target_path)
        except OSError:
            return None

    try:
        target_path.write_text(lyrics_text.rstrip() + "\n", encoding="utf-8")
    except Exception:
        return None

    if not is_valid_lrc_file(target_path):
        try:
            target_path.unlink()
        except OSError:
            pass
        return None

    return target_path


def backup_invalid_lyric(path: Path) -> None:
    for index in range(1, 100):
        suffix = ".invalid" if index == 1 else f".invalid.{index}"
        backup_path = path.with_name(f"{path.name}{suffix}")
        if not backup_path.exists():
            path.rename(backup_path)
            return


def audio_duration_seconds(path: Path) -> int | None:
    try:
        audio = MutagenFile(path)
    except Exception:
        return None
    duration = getattr(getattr(audio, "info", None), "length", None)
    if not isinstance(duration, (int, float)) or duration <= 0:
        return None
    return round(duration)


def search_lrclib_lyrics(artist: str, title: str, duration: int | None = None) -> list[dict[str, object]]:
    params = {"artist_name": artist, "track_name": title}
    if duration:
        params["duration"] = str(duration)

    request = Request(
        f"{LYRICS_PROVIDER_URL}?{urlencode(params)}",
        headers={"User-Agent": "LocalMusicPlayer/0.1 (https://localhost)"},
    )
    try:
        with urlopen(request, timeout=LYRICS_SEARCH_TIMEOUT) as response:
            payload = json.load(response)
    except Exception:
        return []

    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def select_synced_lyrics(candidates: list[dict[str, object]], artist: str, title: str) -> str | None:
    ranked = sorted(candidates, key=lambda item: lyric_candidate_score(item, artist, title), reverse=True)
    for candidate in ranked:
        lyrics_text = candidate.get("syncedLyrics")
        if isinstance(lyrics_text, str) and is_valid_lrc_text(lyrics_text):
            return lyrics_text
    return None


def lyric_candidate_score(candidate: dict[str, object], artist: str, title: str) -> int:
    score = 0
    candidate_title = normalize_match_text(str(candidate.get("trackName", "")))
    candidate_artist = normalize_match_text(str(candidate.get("artistName", "")))
    target_title = normalize_match_text(title)
    target_artist = normalize_match_text(artist)

    if candidate_title == target_title:
        score += 6
    elif target_title and (target_title in candidate_title or candidate_title in target_title):
        score += 2

    if candidate_artist == target_artist:
        score += 4
    elif target_artist and (target_artist in candidate_artist or candidate_artist in target_artist):
        score += 1

    if isinstance(candidate.get("syncedLyrics"), str):
        score += 3
    return score


def normalize_match_text(text: str) -> str:
    return "".join(character.casefold() for character in text if character.isalnum())


def extract_embedded_artwork(path: Path) -> tuple[str, bytes] | None:
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        return None
    except Exception:
        return None

    pictures = tags.getall("APIC")
    if not pictures:
        return None

    picture = pictures[0]
    return picture.mime or "application/octet-stream", picture.data


def has_embedded_artwork(path: Path) -> bool:
    return extract_embedded_artwork(path) is not None


def find_artwork_for_audio(audio_path: Path) -> tuple[str, bytes] | None:
    local_path = local_artwork_path(audio_path)
    if local_path:
        return guess_media_type(local_path), local_path.read_bytes()

    if audio_path.suffix.lower() == ".mp3":
        embedded = extract_embedded_artwork(audio_path)
        if embedded:
            return embedded

    downloaded_path = download_online_artwork(audio_path)
    if downloaded_path:
        return guess_media_type(downloaded_path), downloaded_path.read_bytes()

    return None


def download_online_artwork(audio_path: Path) -> Path | None:
    artist, title = parse_track_name(audio_path.stem)
    query = f"{artist} {title}".strip()
    if not query or artist == "Unknown Artist":
        query = audio_path.stem

    artwork_url = search_itunes_artwork(query)
    if not artwork_url:
        return None

    target_path = audio_path.with_suffix(".jpg")
    if target_path.exists():
        return target_path

    request = Request(artwork_url, headers={"User-Agent": "LocalMusicPlayer/1.0"})
    try:
        with urlopen(request, timeout=ARTWORK_SEARCH_TIMEOUT) as response:
            content_type = response.headers.get("Content-Type", "")
            if not content_type.startswith("image/"):
                return None
            with target_path.open("wb") as output:
                shutil.copyfileobj(response, output)
    except Exception:
        if target_path.exists():
            try:
                target_path.unlink()
            except OSError:
                pass
        return None

    return target_path


def search_itunes_artwork(query: str) -> str | None:
    params = urlencode({"term": query, "entity": "song", "media": "music", "limit": 1})
    request = Request(f"https://itunes.apple.com/search?{params}", headers={"User-Agent": "LocalMusicPlayer/1.0"})
    try:
        with urlopen(request, timeout=ARTWORK_SEARCH_TIMEOUT) as response:
            payload = json.load(response)
    except Exception:
        return None

    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return None

    artwork_url = results[0].get("artworkUrl100")
    if not isinstance(artwork_url, str) or not artwork_url:
        return None
    return artwork_url.replace("100x100bb", "1200x1200bb")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8765), MusicPlayerHandler)
    print("Serving music player at http://127.0.0.1:8765/music-player/")
    print(f"Default music folder: {DEFAULT_MUSIC_DIR}")
    server.serve_forever()
