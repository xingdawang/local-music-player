from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


AUDIO_SUFFIX_BY_FORMAT = {
    "flac": ".flac",
    "mp3": ".mp3",
    "m4a": ".m4a",
    "aac": ".aac",
    "ogg": ".ogg",
    "wav": ".wav",
}

DEFAULT_NCMDUMP_BINARY = "/opt/homebrew/bin/ncmdump"

AUDIO_FORMAT_BY_HEADER = {
    "mp3": (b"ID3",),
    "flac": (b"fLaC",),
    "wav": (b"RIFF",),
    "ogg": (b"OggS",),
}


def sniff_audio_format(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None

    with path.open("rb") as audio_file:
        header = audio_file.read(32)
    if header.startswith(b"ID3") or header.startswith(b"\xff"):
        return "mp3"
    if header.startswith(AUDIO_FORMAT_BY_HEADER["flac"]):
        return "flac"
    if header.startswith(AUDIO_FORMAT_BY_HEADER["wav"]):
        return "wav"
    if header.startswith(AUDIO_FORMAT_BY_HEADER["ogg"]):
        return "ogg"
    if b"ftyp" in header:
        return "m4a"
    return None


def normalize_audio_suffix(path: Path) -> Path:
    actual_format = sniff_audio_format(path)
    if not actual_format:
        return path

    actual_suffix = AUDIO_SUFFIX_BY_FORMAT.get(actual_format, path.suffix)
    if path.suffix.lower() == actual_suffix:
        return path

    normalized_path = path.with_suffix(actual_suffix)
    if normalized_path.exists():
        normalized_path.unlink()
    path.rename(normalized_path)
    print(f"已按真实格式重命名: {normalized_path}")
    return normalized_path


def find_existing_audio_output(expected_path: Path) -> Path | None:
    candidates = [expected_path]
    candidates.extend(expected_path.with_suffix(suffix) for suffix in AUDIO_SUFFIX_BY_FORMAT.values())

    for candidate in dict.fromkeys(candidates):
        if candidate.exists():
            return candidate
    return None


def find_output_for_input(input_file: Path, output_folder: Path) -> Path | None:
    expected_path = output_folder / input_file.with_suffix(".mp3").name
    return find_existing_audio_output(expected_path)


def unlink_existing_audio_outputs(expected_path: Path) -> None:
    candidates = [expected_path]
    candidates.extend(expected_path.with_suffix(suffix) for suffix in AUDIO_SUFFIX_BY_FORMAT.values())

    for candidate in dict.fromkeys(candidates):
        if candidate.exists():
            candidate.unlink()


def unlink_outputs_for_input(input_file: Path, output_folder: Path) -> None:
    expected_path = output_folder / input_file.with_suffix(".mp3").name
    unlink_existing_audio_outputs(expected_path)


def run_ncmdump(input_file: Path, output_folder: Path, ncmdump_binary: Path) -> None:
    if not ncmdump_binary.exists():
        raise FileNotFoundError(
            f"找不到 ncmdump: {ncmdump_binary}. 请先运行 brew install ncmdump，或用 --ncmdump-binary 指定路径。"
        )

    command = [str(ncmdump_binary), str(input_file), "-o", str(output_folder)]
    completed = subprocess.run(command, text=True, capture_output=True, check=False)

    if completed.stdout:
        print(completed.stdout.strip())
    if completed.stderr:
        print(completed.stderr.strip())

    if completed.returncode != 0:
        raise RuntimeError(f"ncmdump 转换失败，退出码: {completed.returncode}")


def move_invalid_audio(path: Path, invalid_folder: Path) -> Path:
    invalid_folder.mkdir(parents=True, exist_ok=True)
    target = invalid_folder / path.name
    if target.exists():
        target.unlink()
    path.rename(target)
    print(f"无效音频已移到: {target}")

    related_lrc = path.with_suffix(".lrc")
    if related_lrc.exists():
        lrc_target = invalid_folder / related_lrc.name
        if lrc_target.exists():
            lrc_target.unlink()
        related_lrc.rename(lrc_target)
        print(f"相关歌词已移到: {lrc_target}")

    return target


def copy_lrc_if_present(input_file: Path, output_audio_file: Path, overwrite: bool = False) -> None:
    source_lrc = input_file.with_suffix(".lrc")
    if not source_lrc.exists():
        return

    target_lrc = output_audio_file.with_suffix(".lrc")
    if target_lrc.exists() and not overwrite:
        print(f"歌词已存在，跳过: {target_lrc}")
        return

    shutil.copy2(source_lrc, target_lrc)
    print(f"已复制歌词: {target_lrc}")


def convert_one_file(
    input_file: Path,
    output_folder: Path,
    invalid_folder: Path,
    ncmdump_binary: Path,
    overwrite: bool = False,
) -> tuple[str, Path | None]:
    print(f"处理文件: {input_file}")

    existing_output_file = find_output_for_input(input_file, output_folder)

    if existing_output_file and not overwrite:
        output_audio_file = normalize_audio_suffix(existing_output_file)
        if sniff_audio_format(output_audio_file):
            print(f"音频已转换，跳过: {output_audio_file}")
            copy_lrc_if_present(input_file, output_audio_file, overwrite=overwrite)
            return "skipped", output_audio_file

        print(f"发现已有输出不是有效音频，重新转换: {output_audio_file}")
        move_invalid_audio(output_audio_file, invalid_folder)

    elif overwrite:
        unlink_outputs_for_input(input_file, output_folder)

    run_ncmdump(input_file, output_folder, ncmdump_binary)
    output_audio_file = find_output_for_input(input_file, output_folder)
    if not output_audio_file:
        raise FileNotFoundError(f"ncmdump 没有生成可识别的输出文件: {input_file}")

    output_audio_file = normalize_audio_suffix(output_audio_file)

    if not sniff_audio_format(output_audio_file):
        invalid_path = move_invalid_audio(output_audio_file, invalid_folder)
        print(f"转换后仍不是浏览器可识别的音频，跳过歌词复制: {input_file}")
        return "invalid", invalid_path

    copy_lrc_if_present(input_file, output_audio_file, overwrite=overwrite)
    return "converted", output_audio_file


def convert_folder(
    input_folder: Path,
    output_folder: Path,
    invalid_folder: Path | None = None,
    ncmdump_binary: Path = Path(DEFAULT_NCMDUMP_BINARY),
    overwrite: bool = False,
    pattern: str = "*.ncm",
) -> None:
    input_folder = input_folder.expanduser().resolve()
    output_folder = output_folder.expanduser().resolve()
    invalid_folder = (invalid_folder or output_folder / "_invalid").expanduser().resolve()
    ncmdump_binary = ncmdump_binary.expanduser().resolve()
    output_folder.mkdir(parents=True, exist_ok=True)

    ncm_files = sorted(input_folder.glob(pattern))
    if not ncm_files:
        print(f"没有找到匹配 {pattern!r} 的 .ncm 文件: {input_folder}")
        return

    converted = 0
    skipped = 0
    invalid = 0
    failed = 0

    for input_file in ncm_files:
        try:
            status, _ = convert_one_file(
                input_file,
                output_folder,
                invalid_folder,
                ncmdump_binary,
                overwrite=overwrite,
            )
        except Exception as exc:
            failed += 1
            print(f"转换失败: {input_file} ({exc})")
            continue

        if status == "converted":
            converted += 1
        elif status == "skipped":
            skipped += 1
        elif status == "invalid":
            invalid += 1
        else:
            failed += 1

    print(f"完成。转换: {converted}, 跳过: {skipped}, 无效: {invalid}, 失败: {failed}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch convert NetEase Cloud Music .ncm files.")
    parser.add_argument(
        "--input-folder",
        default="/Users/xingdawang/Music/网易云音乐",
        help="Folder containing .ncm and optional matching .lrc files.",
    )
    parser.add_argument(
        "--output-folder",
        default="/Users/xingdawang/Music/Converted Music",
        help="Folder where converted audio and .lrc files will be saved.",
    )
    parser.add_argument(
        "--invalid-folder",
        default=None,
        help="Folder where invalid converted files will be moved. Defaults to <output-folder>/_invalid.",
    )
    parser.add_argument(
        "--ncmdump-binary",
        default=DEFAULT_NCMDUMP_BINARY,
        help="Path to the Homebrew ncmdump binary. Defaults to /opt/homebrew/bin/ncmdump.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Re-convert audio and overwrite copied .lrc files even when output files already exist.",
    )
    parser.add_argument(
        "--pattern",
        default="*.ncm",
        help="Glob pattern for selecting .ncm files, for example '*纸短情长*.ncm'.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    convert_folder(
        Path(args.input_folder),
        Path(args.output_folder),
        Path(args.invalid_folder) if args.invalid_folder else None,
        Path(args.ncmdump_binary),
        overwrite=args.overwrite,
        pattern=args.pattern,
    )
