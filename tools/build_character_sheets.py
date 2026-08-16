"""Build the ten production walk-cycle sheets added after the manager.

ImageGen references are 4x4 sheets ordered down, left, right and up. Each
cell is background-keyed, normalized onto a 32x32 logical canvas, palette
reduced, then enlarged 2x for the 64px in-game frame.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
CONCEPTS = ROOT / "assets" / "concepts"
CHARACTER_CONCEPTS = CONCEPTS / "characters"
SPRITES = ROOT / "assets" / "sprites"

SOURCES: dict[str, tuple[Path, str]] = {
    "planner": (CHARACTER_CONCEPTS / "planner-walk-cycle-reference.png", "planner-sheet.png"),
    "researcher": (CHARACTER_CONCEPTS / "researcher-walk-cycle-reference.png", "researcher-sheet.png"),
    "coder": (CHARACTER_CONCEPTS / "coder-walk-cycle-reference.png", "coder-sheet.png"),
    "tester": (CHARACTER_CONCEPTS / "tester-walk-cycle-reference.png", "tester-sheet.png"),
    "reviewer": (CHARACTER_CONCEPTS / "reviewer-walk-cycle-reference.png", "reviewer-sheet.png"),
    "designer": (CHARACTER_CONCEPTS / "designer-walk-cycle-reference.png", "designer-sheet.png"),
    "accountant": (CHARACTER_CONCEPTS / "accountant-walk-cycle-reference.png", "accountant-sheet.png"),
    "communicator": (CHARACTER_CONCEPTS / "communicator-walk-cycle-reference.png", "communicator-sheet.png"),
    "writer": (CHARACTER_CONCEPTS / "writer-walk-cycle-reference.png", "writer-sheet.png"),
    "general": (CHARACTER_CONCEPTS / "general-walk-cycle-reference.png", "general-sheet.png"),
}

LOGICAL_FRAME = 32
FRAME = 64
BODY_HEIGHT = 28
MAX_BODY_WIDTH = 30
FOOT_MARGIN = 2
FACINGS = ("down", "left", "right", "up")
FRAMES_PER_FACING = 4

STANDARD_CELLS: dict[str, tuple[tuple[int, int, bool], ...]] = {
    facing: tuple((row, column, False) for column in range(FRAMES_PER_FACING))
    for row, facing in enumerate(FACINGS)
}

def is_light_checker_pixel(pixel: tuple[int, int, int, int]) -> bool:
    """Return whether a pixel can belong to ImageGen's light checkerboard."""
    red, green, blue, alpha = pixel
    return alpha < 24 or (min(red, green, blue) >= 224 and max(red, green, blue) - min(red, green, blue) <= 12)


def remove_exterior_background(image: Image.Image) -> Image.Image:
    """Flood-fill only the light neutral pixels connected to the canvas edge.

    White shirts stay opaque because their dark character outline separates
    them from the checkerboard. This is safer than deleting every near-white
    pixel globally.
    """
    result = image.convert("RGBA")
    pixels = result.load()
    width, height = result.size
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        index = y * width + x
        if visited[index] or not is_light_checker_pixel(pixels[x, y]):
            return
        visited[index] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        if x > 0:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y > 0:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)

    for index, exterior in enumerate(visited):
        if not exterior:
            continue
        x = index % width
        y = index // width
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
    return result


def opaque_bbox(image: Image.Image, threshold: int = 40) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value >= threshold else 0)
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


def prepare_frame(source: Image.Image, source_cell: tuple[int, int, bool]) -> Image.Image:
    cell = crop_cell(source, *source_cell)
    character = cell.crop(opaque_bbox(cell))
    # Every pose keeps exactly the same height. Wide stride poses are compressed
    # horizontally when needed; shrinking both axes would move the head upward
    # and recreate the floating/bobbing problem fixed in V1.4.6.
    scale = BODY_HEIGHT / character.height
    target_width = max(1, min(MAX_BODY_WIDTH, round(character.width * scale)))
    target_height = BODY_HEIGHT
    character = character.resize((target_width, target_height), Image.Resampling.LANCZOS)
    alpha = character.getchannel("A").point(lambda value: 255 if value >= 32 else 0)
    character.putalpha(alpha)
    # A few generated cells contain faint edge pixels outside the real figure.
    # Remove them after the first resize, then normalize the visible figure one
    # final time so both the head line and foot line are exact.
    character = character.crop(opaque_bbox(character))
    target_width = max(1, min(MAX_BODY_WIDTH, round(character.width * BODY_HEIGHT / character.height)))
    character = character.resize((target_width, BODY_HEIGHT), Image.Resampling.LANCZOS)
    alpha = character.getchannel("A").point(lambda value: 255 if value >= 1 else 0)
    character.putalpha(alpha)

    logical = Image.new("RGBA", (LOGICAL_FRAME, LOGICAL_FRAME), (0, 0, 0, 0))
    x = (LOGICAL_FRAME - target_width) // 2
    y = LOGICAL_FRAME - FOOT_MARGIN - target_height
    logical.alpha_composite(character, (x, y))
    return logical


def reduce_palette(image: Image.Image) -> Image.Image:
    reduced = image.quantize(colors=32, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    alpha = reduced.getchannel("A").point(lambda value: 255 if value >= 96 else 0)
    reduced.putalpha(alpha)
    return reduced


def build_sheet(duty: str, source_path: Path, output_name: str) -> Path:
    source = remove_exterior_background(Image.open(source_path))
    logical_sheet = Image.new(
        "RGBA",
        (LOGICAL_FRAME * FRAMES_PER_FACING, LOGICAL_FRAME * len(FACINGS)),
        (0, 0, 0, 0),
    )

    for row, facing in enumerate(FACINGS):
        for column, source_cell in enumerate(STANDARD_CELLS[facing]):
            frame = prepare_frame(source, source_cell)
            logical_sheet.alpha_composite(frame, (column * LOGICAL_FRAME, row * LOGICAL_FRAME))

    final_sheet = reduce_palette(logical_sheet).resize(
        (FRAME * FRAMES_PER_FACING, FRAME * len(FACINGS)),
        Image.Resampling.NEAREST,
    )
    SPRITES.mkdir(parents=True, exist_ok=True)
    output = SPRITES / output_name
    final_sheet.save(output, optimize=True)
    return output


def main() -> None:
    for duty, (source, output_name) in SOURCES.items():
        output = build_sheet(duty, source, output_name)
        print(f"wrote {output.relative_to(ROOT)} ({FRAME * 4}x{FRAME * 4})")


if __name__ == "__main__":
    main()
