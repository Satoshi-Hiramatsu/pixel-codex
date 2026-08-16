"""Build the production Manager walk-cycle sheet from the 4x4 art reference.

The reference rows are down, left, right and up. Columns are idle, stride A,
passing and stride B. Each cell is normalized onto a 32x32 logical canvas,
then enlarged 2x with nearest-neighbour sampling for crisp game pixels.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "concepts" / "manager-walk-cycle-reference-v1.png"
OUTPUT = ROOT / "assets" / "sprites" / "manager-sheet.png"

LOGICAL_FRAME = 32
FRAME = 64
BODY_HEIGHT = 28
MAX_BODY_WIDTH = 30
FOOT_MARGIN = 2
FACINGS = ("down", "left", "right", "up")
FRAMES_PER_FACING = 4

# The reference's last side-facing poses landed in the opposite rows. Use the
# clean left stride as the anchor and mirror it for the matching right stride;
# this also keeps both side rows on the same head and foot baseline.
SOURCE_CELLS: dict[str, tuple[tuple[int, int, bool], ...]] = {
    "down": ((0, 0, False), (0, 1, False), (0, 2, False), (0, 3, False)),
    "left": ((1, 0, False), (1, 1, False), (1, 2, False), (2, 3, False)),
    "right": ((2, 0, False), (2, 1, False), (2, 2, False), (2, 3, True)),
    "up": ((3, 0, False), (3, 1, False), (3, 2, False), (3, 3, False)),
}


def opaque_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value >= 48 else 0)
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("Reference cell contains no visible character")
    return bbox


def crop_cell(source: Image.Image, row: int, column: int, mirror: bool) -> Image.Image:
    left = round(source.width * column / FRAMES_PER_FACING)
    right = round(source.width * (column + 1) / FRAMES_PER_FACING)
    top = round(source.height * row / len(FACINGS))
    bottom = round(source.height * (row + 1) / len(FACINGS))
    cell = source.crop((left, top, right, bottom))
    if mirror:
        cell = cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return cell


def prepare_frame(
    source: Image.Image,
    source_cell: tuple[int, int, bool],
) -> Image.Image:
    cell = crop_cell(source, *source_cell)
    character = cell.crop(opaque_bbox(cell))
    # Normalize every pose independently. Image generators often render the
    # passing pose a little smaller, which otherwise makes the whole person
    # hop even though only the legs are meant to move.
    scale = BODY_HEIGHT / character.height
    scale = min(scale, MAX_BODY_WIDTH / character.width)
    target_width = max(1, round(character.width * scale))
    target_height = max(1, round(character.height * scale))
    character = character.resize(
        (target_width, target_height),
        Image.Resampling.LANCZOS,
    )

    logical = Image.new("RGBA", (LOGICAL_FRAME, LOGICAL_FRAME), (0, 0, 0, 0))
    x = (LOGICAL_FRAME - target_width) // 2
    # Keep the head and foot baseline fixed in every direction. The gait is
    # expressed by alternating limbs only, never by moving the whole body.
    y = LOGICAL_FRAME - FOOT_MARGIN - target_height
    logical.alpha_composite(character, (x, y))
    return logical


def reduce_palette(image: Image.Image) -> Image.Image:
    reduced = image.quantize(colors=32, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    alpha = reduced.getchannel("A").point(lambda value: 255 if value >= 96 else 0)
    reduced.putalpha(alpha)
    return reduced


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    logical_sheet = Image.new(
        "RGBA",
        (LOGICAL_FRAME * FRAMES_PER_FACING, LOGICAL_FRAME * len(FACINGS)),
        (0, 0, 0, 0),
    )

    for row, facing in enumerate(FACINGS):
        for column, source_cell in enumerate(SOURCE_CELLS[facing]):
            frame = prepare_frame(source, source_cell)
            logical_sheet.alpha_composite(
                frame,
                (column * LOGICAL_FRAME, row * LOGICAL_FRAME),
            )

    logical_sheet = reduce_palette(logical_sheet)
    final_sheet = logical_sheet.resize(
        (FRAME * FRAMES_PER_FACING, FRAME * len(FACINGS)),
        Image.Resampling.NEAREST,
    )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    final_sheet.save(OUTPUT, optimize=True)
    print(f"wrote {OUTPUT} ({final_sheet.width}x{final_sheet.height})")


if __name__ == "__main__":
    main()
