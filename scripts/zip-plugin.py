import argparse
import zipfile
from pathlib import Path


def build_archive(source: Path, output: Path):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.iterdir()):
            archive.write(path, path.relative_to(source))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Package the MP plugin files at the ZIP root")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_archive(args.source, args.output)
