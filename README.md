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

## Web version (Chrome, Edge, Firefox)

The `web/` folder is a browser version of the same detector. It doesn't need
Python and gives the same detections. It runs entirely in the browser;
no audio leaves your PC.

**Start it:** double-click `web/index.html` (or `web.bat`). It works straight from
disk, with no install or web server. To use it from any PC, turn on GitHub Pages for
the repo (Settings → Pages → Deploy from a branch → `main`, `/ (root)`) and open
`https://<user>.github.io/redfinder/web/`.

**Pick the audio source:**

- **Chrome / Edge:** click *Capture system audio*, choose **Entire screen**, and
  tick **Share system audio**. Only the audio is used.
- **Firefox** (or any browser): Firefox can't capture system audio, so use an
  input device that carries your game audio and click *Use input device*:
  - **Stereo Mix:** enable it in Windows Sound settings → Recording, or
  - **VB-Audio Virtual Cable:** select *CABLE Output*, and route the game to it
    (with *Listen to this device* turned on so you still hear it).

**Alerts:** a browser page can't draw over the game, so alerts come as:

- a beep,
- a Windows desktop notification (tick *Desktop notification*; turn off Focus
  assist / Do not disturb for games, or it hides them),
- in Chrome / Edge, an **always-on-top pop-out window** that stays above a
  Borderless / Windowed game. Drag it to the top of the screen.

The *Live match scores* panel replaces `--calibrate`, *Also show non-red merchant
sounds* replaces `--all`, and the *Learn* section replaces `--learn`. Learned
thresholds are saved in the browser, not in `thresholds.json`.

Keep the tab open (it may be in the background) while you play.

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
- `web/`: the browser version (`detector.js` is a port of the matcher, `app.js` the page logic)
- `web/data.js`: the sounds and item list bundled for the page; regenerate with `python web/build_data.py`
- `web.bat`: opens the web version
