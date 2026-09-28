# Swar Pehchaan

Sing into your microphone and see the **Indian classical sargam notation** of what you sang: Sa, Re, Ga, Ma, Pa, Dha, Ni, including komal (flat) and tivra (sharp) swaras and mandra/taar octave marks.

It runs entirely in the browser. There's no server and no install, and your audio never leaves your device.

## Features

- **Live transcription:** the notes you sing appear as you sing them, and a pause starts a new phrase `|`.
- **Ornaments, not just main notes:** quick touches are written as small **kan swaras**, slides as **meend** arcs, andolan stays one oscillating note, and fast murki / gamak turns are caught note by note.
- **Detail setting:** *Main notes only*, *Notes + kan swar & meend* (default), or *Every movement*.
- **All 12 swaras:** Sa, komal Re, Re, komal Ga, Ga, Ma, tivra Ma, Pa, komal Dha, Dha, komal Ni, Ni.
- **Octave marks:** a dot below means mandra (lower octave) and a dot above means taar (upper octave).
- **Your own Sa:** pick it from a list (C … B), or press **Sing your Sa** and hold your note for 2 seconds.
- **Tuning meter and pitch trace:** see how many cents sharp or flat you are, and see your meend and andolan against the swar lines.
- **Tanpura:** a synthesised four-string tanpura (first string, Sa, Sa, kharaj Sa) with jawari buzz, automatically tuned to your Sa. You can set the first string to Pa, Ma or Ni and adjust speed and volume. Use headphones while singing so the mic doesn't pick it up.
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
| Notes | A median filter removes octave blips. The voice has to move more than about half a semitone to count as a new swar, so vibrato and andolan don't split a note. Swaras touched for 25–45 ms or more are written. Those held past the *main-note hold* are main notes, and shorter ones become kan swaras. A slide lasting 60 ms or more between two written swaras is marked as meend. |

The core logic is in [`swar-core.js`](swar-core.js) and has no dependencies. The tanpura is in [`tanpura.js`](tanpura.js): each string is built from up to 48 harmonics whose upper overtones swell shortly after the pluck, the way a jawari bridge makes them. The UI is in `app.js`.

### Notation used

| Mark | Meaning | Text form |
|---|---|---|
| <u>Re</u> (underlined) | komal | `Re(k)` |
| Ma with a tick above | tivra | `Ma(t)` |
| dot below | mandra saptak | `.Ni` |
| dot above | taar saptak | `Sa'` |
| small raised swar | kan swar (grace note) | `[Ga]Re` |
| arc between swaras | meend (slide) | `Pa~Ga` |

## Tips and limitations

- **Set Sa first.** Every swar is relative to it. For a film song like *Lag Ja Gale*, find the key the song is in (or sing along and use **Sing your Sa**).
- It works best with **one voice or one instrument**. Recordings with an orchestra, tabla or harmonium behind the voice will produce noisy results. For those, separate the vocals first with a tool such as [Demucs](https://github.com/facebookresearch/demucs) and upload the vocal track.
- To catch fast taans, murki and gamak, choose **Every movement**. If you're seeing too many small notes, switch to **Main notes only** or raise the main-note hold.
- Equal temperament is used. Shruti-level (22-note) detail is not modelled.

## Tests

```bash
node test/core.test.js
```

This synthesises sung phrases (vibrato, kan swar, meend, andolan, murki, a breathy voice) and checks each one is transcribed correctly. It also checks that the tanpura strings are in tune.

## Roadmap ideas

- Auto-detect Sa from a whole recording (a histogram of pitches).
- Vocal separation in the browser.
- Export notation in Bhatkhande style with taal / matra divisions.
- Raga hints from the set of swaras used.
