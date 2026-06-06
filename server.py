from __future__ import annotations

import json
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from mutagen.id3 import ID3, ID3NoHeaderError
from pypinyin import Style, lazy_pinyin


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MUSIC_DIR = Path("/Users/xingdawang/Music/Converted Music")
AUDIO_EXTENSIONS = {".mp3", ".flac", ".wav", ".m4a", ".ogg", ".aac"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}


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

        super().do_GET()

    def send_json(self, payload: object, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
        if requested.suffix.lower() != ".mp3":
            self.send_error(415, "Embedded artwork is only supported for MP3 files")
            return

        artwork = extract_embedded_artwork(requested)
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


def parse_track_name(stem: str) -> tuple[str, str]:
    parts = stem.split(" - ", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return "Unknown Artist", stem


def quote_path(name: str) -> str:
    from urllib.parse import quote

    return quote(name)


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


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8765), MusicPlayerHandler)
    print("Serving music player at http://127.0.0.1:8765/music-player/")
    print(f"Default music folder: {DEFAULT_MUSIC_DIR}")
    server.serve_forever()
