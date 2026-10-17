---
name: image-generation
description: Use when someone in a chat asks for an image to be made or a photo to be edited (a sticker idea, a joke picture, a hat on a face, a recoloured object), or when the owner asks to test the local image models. Holds the commands, timings, memory limits and the rules for pictures of real people.
---

# Image generation

Local, on the owner's machine, no cloud calls. Two models behind one script, `scripts/imggen.py`, run with `python3` and `dangerouslyDisableSandbox: true` (the GPU is not reachable from the sandbox).

| Mode | Model | Time on an M1 Pro | Peak memory | Good at |
| --- | --- | --- | --- | --- |
| `generate` | Z-Image-Turbo, 4-bit, 8 steps | about 2 minutes | 7.6 GB | pictures from a prompt, clean objects, product-style shots |
| `edit` | FLUX.1 Kontext dev, 4-bit, 20 steps | about 11 minutes | 13.8 GB | recolouring, restyling, changing the background. Adding new objects is unreliable (a requested extra object was ignored in testing) |

`generate --model NAME` also takes `dev` (FLUX.1 dev, about 6 minutes), `schnell` (about 1 minute, the fallback if two minutes is too slow) and any name the owner has added, either with `install_model.py --as NAME` (recorded in `state/models.json`) or by hand in `state/imggen-models.json` (both gitignored; `--list-models` prints them all). An entry names an mflux generate command and its options (model, base_model, steps, quantize, guidance, lora_paths, lora_scales) and nothing else. Use a name from that list only when the owner or the chat asks for it, and never invent one. A model the owner calls by a person's name is that person's likeness: use it only for that person, in a chat where they asked or the owner did.

## How a request runs

1. Reply with one short holding line in the chat's persona ("yapiyorum", about two minutes) if the work is more than a few seconds. One line, not a stream of updates.
2. Run the script in the background (`run_in_background: true`) so the inbox watch keeps running. Do not poll. The completion notice arrives on its own.
   For a render longer than a couple of minutes, the owner's instruction (2026-10-15) is to edit that one holding message about once a minute with the progress instead of sending new messages. Read it from the tail of `state/imggen.log` (the `N/steps` counter of the progress bar), or run a `Monitor` that prints it every 60 seconds and edit on each event with `wa_edit`. Keep it short and in the persona's voice ("%40 jsdkl"). WhatsApp only allows edits for about 15 minutes, so stop editing past that and do not start a second message. When the image is ready, send it and edit the holding line a last time to say it is done.
3. Output must go to `<session scratchpad>/outbox/<name>.png`. The script refuses any other location. Only `outbox/` is a send source.
4. When it finishes, send the file with `wa_send_image` to the chat that asked, and only that chat, with at most a short caption.
5. If it fails, say so in one short line in the persona and stop. The owner's DM is the only place to talk about `state/imggen.log` or the cause.

```bash
python3 scripts/imggen.py generate --prompt "..." --out "$SCRATCH/outbox/name.png" [--width 768 --height 768 --seed N]
python3 scripts/imggen.py edit --image <source photo> --prompt "..." --out "$SCRATCH/outbox/name.png"
```

The script prints one JSON line, `{"ok": true, "out": ..., "seconds": ...}` or `{"ok": false, "error": ...}`.

## Limits

- One render at a time. A lock file serialises calls, because two image models do not fit next to the voice service on 32 GB. A second request waits. Tell the requester it is queued, once.
- Memory frees when the script exits. Nothing stays loaded between requests.
- Prompts for `generate` are English, short and concrete. For a sticker look, ask for flat illustration on a plain background.
- `edit` keeps the source's size. Say what to change and what to keep ("make the hat blue, keep everything else").

## Rules for pictures of real people

These hold in every chat and for every persona.

- Edit a real person's photo only when that person asked, or the owner did, in the chat where the photo came from. Do not carry a photo from one chat into another, and never send an edit to a chat other than the one that asked. The source photo is read from the inbound media folder, the result goes to `outbox/`.
- Keep edits harmless and obviously a joke: hats, colours, backgrounds, costumes. No sexual, humiliating, violent, political or news-style pictures of a real person, and nothing that could pass as a real photo of something that did not happen.
- No image that pretends to be a screenshot, a document, an ID or a message from a real person or organisation.
- Refuse in persona, in one line, without lecturing. Do not offer a workaround.
- Do not describe how the images are made (model, tools, paths, timings, memory). A deflection in persona is enough, same as every other setup question.

## Setup, once per clone

`state/` is gitignored, so a fresh clone has neither the environment nor the weights.

```bash
python3.12 -m venv state/imggen-venv
state/imggen-venv/bin/pip install mflux
printf '%s' '<huggingface token>' > state/hf-token && chmod 600 state/hf-token
```

The Kontext weights are gated on Hugging Face, so the owner's account must have accepted the model's licence. The first run of each mode downloads the weights (roughly 10 GB for Z-Image-Turbo, about 30 GB for Kontext), which takes several minutes. Keep the token out of messages, logs and commits.
