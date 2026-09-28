# Swar Pehchaan

Sing into your microphone and see the **Indian classical sargam notation** of what you sang: Sa, Re, Ga, Ma, Pa, Dha, Ni, including komal (flat) and tivra (sharp) swaras and mandra/taar octave marks.

It runs entirely in the browser. There's no server and no install, and your audio never leaves your device.

## Features

- **Live transcription:** a note is written down once you've held it steadily (the hold time is adjustable). A pause starts a new phrase `|`.
- **All 12 swaras:** Sa, komal Re, Re, komal Ga, Ga, Ma, tivra Ma, Pa, komal Dha, Dha, komal Ni, Ni.
- **Octave marks:** a dot below means mandra (lower octave) and a dot above means taar (upper octave).
- **Your own Sa:** pick it from a list (C … B), or press **Sing your Sa** and hold your note for 2 seconds.
- **Tuning meter and pitch trace:** see how many cents sharp or flat you are, and see your meend and andolan against the swar lines.
- **Sa–Pa drone:** a simple tanpura-like reference to sing against.
- **Recording analysis:** upload an mp3, wav or m4a file and get its notation.
- **Copy as text:** e.g. `Sa Re Ga(k) Ma(t) Pa Dha(k) Ni Sa' .Ni`

## Run it

The microphone only works on `https://` or `localhost`, so serve the folder instead of double-clicking the file:

```bash
git clone https://github.com/sameer03/swar-pehchan.git
cd swar-pehchan
python3 -m http.server 8000
# open http://localhost:8000
```

### Put it online with GitHub Pages

1. Open the repo on GitHub and go to **Settings → Pages**.
2. Under **Source**, choose **Deploy from a branch**, then pick `main` / `/ (root)` and save.
3. After a minute it's live at `https://sameer03.github.io/swar-pehchan/`.

## How it works

| Step | What happens |
|---|---|
| Capture | Web Audio API reads 2048-sample frames from the mic (or the decoded file). |
| Pitch | The **YIN** algorithm finds the fundamental frequency of each frame (65–1100 Hz). |
| Swar | `semitones = 12 · log2(f / Sa)`, rounded to the nearest of the 12 swaras. The remainder is shown in cents. |
| Notes | A segmenter commits a swar only after it's held for the hold time, and it ignores glides between notes. |

The core logic is in [`swar-core.js`](swar-core.js) and has no dependencies. The UI is in `app.js`.

### Notation used

| Mark | Meaning | Text form |
|---|---|---|
| <u>Re</u> (underlined) | komal | `Re(k)` |
| Ma with a tick above | tivra | `Ma(t)` |
| dot below | mandra saptak | `.Ni` |
| dot above | taar saptak | `Sa'` |

## Tips and limitations

- **Set Sa first.** Every swar is relative to it. For a film song like *Lag Ja Gale*, find the key the song is in (or sing along and use **Sing your Sa**).
- It works best with **one voice or one instrument**. Recordings with an orchestra, tabla or harmonium behind the voice will produce noisy results. For those, separate the vocals first with a tool such as [Demucs](https://github.com/facebookresearch/demucs) and upload the vocal track.
- Fast taans and heavy gamak may be shortened or skipped. Lower the hold time to catch faster notes, or raise it to reduce noise.
- Equal temperament is used. Shruti-level (22-note) detail is not modelled.

## Tests

```bash
node test/core.test.js
```

This synthesises a scale and checks that it is transcribed correctly.

## Roadmap ideas

- Auto-detect Sa from a whole recording (a histogram of pitches).
- Vocal separation in the browser.
- Export notation in Bhatkhande style with taal / matra divisions.
- Raga hints from the set of swaras used.
