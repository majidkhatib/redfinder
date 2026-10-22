# ABI Red Item Detector

Listens to your PC's sound output and shows **RED ITEM DETECTED** at the top of
the screen (with a beep) when it hears an Arena Breakout: Infinite merchant
item sound that belongs to a red item. The sounds and item list come from
https://abibuilder.com/merchant.

## Run

Double-click `run.bat`. The first time, it installs the Python packages it needs
(numpy, scipy, soundfile, pyaudiowpatch). Press Ctrl+C in the console window to quit.

- Run the game in **Borderless / Windowed** mode. The overlay can't draw over exclusive fullscreen.
- The bot listens to the **default Windows output device** (your headset or speakers).
- An alert appears about 0.6–1 s after the sound, once the whole sound has been heard.

## What the alert means

Most merchant sounds are shared between several items of different rarities.
Only the **Antique Teapot** sound is used by red items alone.

| Overlay text | Meaning |
|---|---|
| `RED ITEM DETECTED` (red) | The sound is only used by red items (Antique Teapot). |
| `RED ITEM DETECTED (possible)` (orange) | Some items with this sound are red. The second line shows the percentage and which red items. |

The console keeps a log of every detection.

## Options

```
python red_detector.py --all          also show non-red merchant sounds (useful for testing)
python red_detector.py --calibrate    print the top live match scores
python red_detector.py --no-beep
python red_detector.py --threshold 0.7   raise the minimum score for every sound (default 0.65)
python red_detector.py --learn 300    see below
```

### Too many false alerts? Use `--learn`

Some merchant sounds are generic rustles that ordinary game audio can resemble.
Run `python red_detector.py --learn 300` and play normally for 5 minutes,
**away from the merchant**: gunfire, footsteps, looting, voice chat, and so on.
It records how closely that audio resembles each merchant sound and raises the
per-sound thresholds in `thresholds.json` so it stops triggering. You can run
it several times; thresholds only go up. To reset, restore the original
`thresholds.json`.

## Files

- `red_detector.py`: the detector
- `sounds/`: the 38 merchant pickup sounds from abibuilder.com
- `sound_items.json`: which items (and rarities) use each sound
- `thresholds.json`: per-sound match thresholds
- `selftest.py`: offline accuracy test (`python selftest.py`)
