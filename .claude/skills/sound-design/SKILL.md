---
name: sound-design
description: Use when a video, slideshow (the old .pps joke style), meme clip or long voice note needs a soundtrack - narration, a music bed, sound effects - or when the owner says the sound of something was weak. Holds what was measured from real examples, a synthesised effects kit and music bed, and a timeline mixer.
---

# Sound design

The visuals of a joke video are the easy half. What makes it land is the soundtrack, and the first
attempt (a slideshow with a few beeps over silence) sounded empty. This skill is what was learned by
measuring real examples instead of guessing. Claude cannot hear audio, so everything here is
checked by numbers: loudness, silences, a transcript, and a spectrogram picture that can be read.

## What the references showed (measured 2026-10-23)

Four YouTube examples of the genre were downloaded and analysed: a narrated Temel joke in the
"Paint Terk" style (1.3M views), a pps-era narrated story ("msj" video), a slideshow set to a song,
and an explainer on the meme-PowerPoint formula.

- **The narration carries the joke.** Both narrated videos are a voice telling the joke from start
  to finish. The pictures barely change (one cut in 53 seconds). Without a voice it is a slideshow.
- **There is never silence.** A music bed runs under the whole thing: steady harmonic lines below
  about 1.3 kHz on the spectrogram, no gaps at all. Mean loudness of the empty first attempt was
  -30 dB with long silences, the references had none.
- **Levels:** the bed alone is about -28 LUFS, the narrated parts about -22. The voice is only
  6 to 7 dB above the music, so the bed is clearly heard. A finished track is -16 to -23 LUFS, and
  -16 suits a phone speaker.
- **Timing:** 2 to 3 seconds of music before the first line, 0.5 to 1.2 s (typically 0.9) between
  lines with the music still playing, and 2 to 3 s of music tail after the punchline.
- **The genre's visual rules** (from the explainer): needless transitions, visually overwhelming
  and factually underwhelming, a joke slide whose body undercuts its title, a slightly odd thank-you
  closing slide. Sound follows the same idea: one effect per beat, never a wall of effects.

## The pps culture (Turkish forwarded slideshows, mid-2000s)

Read from a 2020 archive page of 122 forwarded presentations (jn7.net, "Birbirinden İlginç ve Şahane
Powerpoint Sunumları"). The page lists them by category, which shows what the genre actually was.

- **Mostly sentimental, not funny.** Of 122, only 10 are in "Komik". The big groups are friendship
  (dostlar, arkadaşım, "dostlarınızı denemek ister misiniz"), love, "Hayat Dersi" life lessons,
  religious ones, history and Atatürk, nature photos ("muhteşem doğa", National Geographic,
  "harika yerler"), and a large politics-and-conspiracy group the page itself warns not to trust.
- **The ibretlik parable is the core form.** A short moral story ("kelebek dersi", "bedevi",
  "5 ders"), a lesson at the end, then a request to pass it on. Our king and guard story is exactly
  this shape.
- **The comic ones** are workplace and daily-life jokes ("maaş artışları", "stres testi", "kırmızı
  noktayı bul", "ofis manzaraları", "karadenizli müteahhit") and, often, jokes about women. Keep the
  format and the warmth, and make the joke land on Temel, not on a group of people: a joke where
  Fadime is the slow one reads as sexist today, and a listener said so, fairly.
- **File names say how it was made:** "salavatsesli.pps" (sesli means it carried music),
  "lutfen-okuyunuz", "mutlaka okuyun", "sizbilmezsiniz". Titles in capitals, pleading tone.
- **Conventions to borrow:** an opening "BİLGİSAYARINIZIN SESİNİ AÇINIZ", an all-caps title,
  pictures of nature or kittens with a caption, one sentence per slide, a "PEKİ ... NE DEMİŞ?"
  reveal slide, and a closing "GÜLMEK SİZE YAKIŞIYOR" or "bu sunumu 10 dostunuza gönderin" slide
  with the sender's nickname.
- **Sound:** the page lists no music. From the genre generally (not checked against these files):
  the sentimental ones ran a slow emotional instrumental (piano, flute, ney) under every slide, so a
  slow `--mood sad --bpm 70` bed fits a parable better than the bouncy pop bed, which fits the comic
  ones.

## Recipe for a narrated joke video

1. Write the lines. Each character gets a voice from the owner's approved cast (`state/notes.md`).
2. Render each line to a file with `wa_render_voice` (same `[voice NAME]` spans as voice notes).
   Only voices allowed in every chat can be rendered, because a file can go anywhere. If that tool
   is missing from the session, the server was updated and the owner has to reconnect with `/mcp`.
3. Build the effects and a bed:
   ```bash
   .claude/skills/sound-design/scripts/sfx.py kit state/tmp/kit
   .claude/skills/sound-design/scripts/sfx.py bed state/tmp/bed.wav --seconds 30 --mood happy
   ```
   Kit: whoosh (transitions), pop and ding (a word or picture appearing), typewriter, boing,
   drumroll (before the punchline), tada, applause, rimshot (after a pun), sad-trombone (a fail),
   scratch (record stop, "wait what"). Moods: happy (I V vi IV), sad, tense.
4. Lay out a timeline: bed from 0, first line at 2.5 s, the next line 0.9 s after the previous one
   ends, a drumroll in the beat before the punchline, tada or rimshot right after it, 2.5 s tail.
5. Mix: `.claude/skills/sound-design/scripts/mix.py timeline.json out.wav`. It brings each line to
   -21 LUFS, puts the bed at -28, ducks the bed while a voice plays, and normalises to -16 LUFS.
6. Put the slides on the same timeline (a slide change on each line) and mux the audio in.
7. **Check before sending**, every time:
   - loudness of the result (`ffmpeg -af ebur128`): about -16 LUFS integrated, no true peak over -1.
   - silences (`silencedetect=n=-45dB:d=0.4`): there should be none.
   - a transcript of the result with whisper: every line present, in order, nothing cut off.
   - the spectrogram (`showspectrumpic`): a steady bed under the speech, no full-height vertical
     lines (clicks), no buzz smeared up to 20 kHz.
   - the frames on a contact sheet (`watch_video.py`), slide changes lining up with the lines.
8. Preview in the owner's DM first when it is a new style or cast.

## Rules

- Make the sound ourselves. The references are for learning the shape and the numbers only.
  Never cut audio out of someone's video to reuse it, and never ship a downloaded song as a bed.
- Effects punctuate, they do not decorate: one on a slide change, one on the punchline. Six
  overlapping effects read as noise.
- A clip shorter than 0.4 s has no integrated loudness (ebur128 gates it), so the mixer levels
  short effects by peak instead. A reading of -70 LUFS on a pop means "too short", not "silent".
- Keep studied downloads in `state/tmp/` and delete them when done.
