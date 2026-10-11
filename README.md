# Daphne

A drawn-sound instrument after Daphne Oram's Oramics machine. You draw the
sound, on paper or on screen, and the machine plays what you drew.

Built for running workshops. Print the sheets, let people draw on them, play the
results.

**[Download v0.4.0](https://github.com/stuart78/daphne/releases/tag/v0.4.0)**
for macOS, Windows or Linux. The macOS build is signed and notarised, so it
opens normally. Windows is unsigned and SmartScreen will warn once.

```bash
pnpm install
pnpm dev          # run the app
pnpm template     # generate sheets to print
pnpm test
```

## Packages

| | |
|---|---|
| `engine` | The voice. Plain TypeScript, no Web Audio, no DOM, no Node. |
| `template` | Printable sheets, and the geometry everything shares. |
| `vision` | Reading a photographed sheet back: registration and extraction. |
| `midi` | Reading a MIDI file onto the strips. |
| `app` | Drawing surfaces, audio client, projector view, PDF export. |
| `shell` | Electron: windows, external display, save dialog. |

Keeping the engine free of platform code is the decision everything else rests
on. The same module runs in the AudioWorklet, in an offline bounce at whatever
speed the CPU manages, and in a unit test. It can move to WASM or a JUCE plugin
later without a rewrite. A test asserts that a 128-sample worklet render and an
offline bounce agree to 1e-9, so a bounce always matches what you heard.

`vision` follows the same rule for the same reason. It takes pixels and returns
numbers, with no DOM and no Node anywhere in it, so it runs against a canvas in
the app, against a rendered sheet in a test, and in a watch folder later.

## The machine

Ten synchronised 35 mm film strips ran over photocells. Four carried pitch as
binary-coded whole Hertz, four carried amplitude (one per timbre), and one each
carried vibrato, reverberation and transport. Four hand-painted glass slides sat
in front of CRTs to supply the waveforms: a photomultiplier feedback loop
dragged a scanning dot onto the painted contour, and the resulting voltage was
the wave. Output was mono. Polyphony came from multitracking to tape.

Several of its constraints are modelled rather than approximated, because they
are most of why it sounds the way it does. Each is a switch in the app, so you
can hear 1969 and then leave it.

### Timbre is a servo, not a wavetable

Oram's surviving slides carry four thick, irregular ribbons of paint stacked
vertically, each spanning the full width, with clear glass above and below.
None of that is a single-valued function of x.

Graham Wrench, who built the electronics, described how the machine read them:
the spot sweeps left to right, and "if obscured by the opaque part of the drawn
waveform, the photomultiplier would detect no light, and the beam would move
higher until the photomultiplier could see it." Dark pushes the spot up, light
pulls it down, and it balances on the *top edge* of the paint.

So `scanner.ts` runs that loop at audio rate over a 2-D opacity field, one
bilinear lookup and a few flops per sample. The character comes out of the loop
rather than being added afterwards:

- **Timbre changes with pitch.** The sweep rate is the note frequency, but the
  loop bandwidth is fixed. Measured on one slide, a normalised shape factor of
  2.58 at 73 Hz and 0.52 at 766 Hz, smoother than a sine because the loop has
  rounded the whole stroke off. The wavetable path reads 2.55 and 2.57, flat by
  construction. A table cannot do this.
- **Ribbon thickness is inaudible.** The underside is unreachable.
- **A gap costs level, not just a click.** The spot dives to the rail and the AC
  coupling strips the DC, so a gapped stroke came out 5x quieter than the same
  stroke intact.
- **Complex shapes get harsher**, matching the Science Museum caption. One
  smooth ribbon reads 1.38. Add a fast wiggle band above it and it reads 7.73.
- **It rings, inharmonically.** The loop's natural frequency is fixed, so the
  ring does not transpose with the note.
- **No two cycles are identical.** Loop state carries across the flyback.

Free-floating ribbons are only locally stable. A spot below one sees light and
dies on the bottom rail, so the loop has a search mode, as real tracking servos
do. It sweeps up to reacquire, but only when the column actually contains paint.
An empty carrier sits dark instead of hunting.

### Pitch is a whole number of Hertz

Wrench again: "one strip would set the number of units of cycles per second; one
set the number of tens of cycles; a third set the number of hundreds of cycles;
the last would set the number of thousands." Those relays "switch in banks of
resistors and make the time-base run at whatever frequency."

Resistors in parallel, so conductance sums, so frequency is proportional to the
coded number. The painted code does not represent a pitch. It *is* the frequency
in Hertz. Two things follow:

- **The scale is linear, not logarithmic.** Octaves fall unevenly: 110 Hz a
  ninth of the way up, 220 at a fifth, 440 just under half, 880 near the top.
  Drawing a tune on it feels wrong, and that is the authentic feeling.
- **Resolution is one Hertz everywhere.** 31 cents at 55 Hz, 2 cents at 880.
  Bass lines step audibly. High lines do not.

The tracks are weighted **1-2-4-2** reading up from the film's lower edge, not
the 8-4-2-1 you would reach for today. They sum to 9, so every digit is
reachable, and several have two paintings. 4 is either the single 4 track or
both 2s, and the machine cannot tell them apart.

The relays latch, so pitch persists between neumes, which is why a painted strip
is mostly blank. They are also mechanical and do not move together, so 199 Hz to
200 Hz flips eight tracks and the bank spells frequencies nobody painted for
about ten milliseconds. Changes within one digit are clean. Decimal carries
stumble.

### Amplitude is a light bulb

Level was set by shining a torch bulb at a photoresistor. Filament thermal mass
plus asymmetric cell recovery means no envelope has a sharp attack, and released
notes hang on longer than the drawing says.

## Pitch as notes

The Hertz strip is the machine as built, and it stays the default. It is also
hard to draw a tune on: octaves fall unevenly up a linear scale, so middle C and
the C above sit a hand's width apart at the bottom and nearly touch at the top.

**Notes** splits pitch into two bands, a note band of twelve rows over an octave
band of eight rows. This is the shape of Oram's own later design, and of Tom
Richards' Mini Oramics, rather than the 1969 machine. Switch with the Hertz and
Notes buttons on the pitch lane, or ⇧⌘H.

- **Dots or lines** (⇧⌘L). A dot sets a note that holds until the next mark,
  and only where the dot starts counts. A line is followed as it moves, one row
  at a time, with enough hysteresis that a hand resting on a row boundary does
  not flicker between two notes.
- **Key and scale.** Chromatic by default. Pick a root and a scale and marks
  snap to the nearest note in it, ties going down, never wrapping into the next
  octave. With a scale chosen the notes outside it are shaded.
- **What you see is what plays.** The reading is drawn over the marks as a
  staircase, with dashed lines where the relays hold a note across blank paper.
- The octave band is octaves 1 to 8, so middle C is the C row in octave 4. The
  frequency is still rounded to a whole Hertz by the relays, so middle C plays
  at 262.

**Blank sheet** prints the note sheet when the app is in Notes mode: light grey
rows for the notes, with the sharps shaded, and eight octave rows below. The QR
says which sheet it is, so importing a photo of one switches the app to Notes.

## Keys

| | |
|---|---|
| Space | play or stop |
| ⇧⌘H | pitch in Hertz or Notes |
| ⇧⌘L | notes as dots or lines |
| ⌘+ ⌘- ⌘0 | zoom in, out, fit |
| ⌘D | next theme |
| ⌘S ⌘O | save, open |
| ⌘N | clear and start again |
| ⇧⌘A | export audio |

## The 30-second guarantee

The printed time field is exactly 300 mm at 10 mm/s, so a sheet is 30.000 s by
construction. 1 cm is 1 second and 1 mm is 100 ms. That is one tenth of the
machine's 100 mm/s film speed. At her speed a Legal sheet would last 3.5
seconds.

Nothing downstream measures millimetres off paper. Four corner fiducials define
a reference rectangle, the extractor solves a homography onto their known
coordinates, and print scale, scan DPI, skew and lens distortion all drop out.
Each sheet carries a QR describing itself, so importing is scan-and-drop and the
app takes its speed from the sheet.

See [`packages/template/README.md`](packages/template/README.md).

## Round trip

Draw in the app, hit **Export PDF**, and you get the same sheet people draw on
with your lines printed onto it. One page: every lane as a band, the four
timbres in a strip underneath. Print it, let someone mark it up by hand, scan it
back. That works because the app and the printed template share one geometry
module.

## Reading a sheet back

**Import scan** takes a photograph or a flatbed scan of a printed sheet and
turns the marks on it into lanes. Three steps, each of which can fail honestly
rather than guessing.

**Register.** The four corner squares are found, and a homography solved onto
their known page coordinates. Print scale, scan DPI, page skew, the angle the
phone was held at and most lens distortion all drop out together. Measured
against rendered sheets put through a simulated camera, the worst position error
anywhere on the page is about a tenth of a millimetre. Three corners are not
enough and the importer says so instead of fitting a plausible wrong map.

**Describe.** The QR is rectified using that map and decoded, so the sheet says
which piece it belongs to and how long its field is meant to last.

**Extract.** Each band and panel is sampled where the template says it is. The
threshold is calibrated from the corner squares, which are the one thing on the
page guaranteed to be solid black: everything printed is then a known fraction
of it, so the same setting works for a flatbed scan, a phone under a window and
a photocopy of a photocopy.

The sheet declares its own printed furniture so the extractor can ignore it. A
mark is discarded only when it fits entirely inside the strip a printed rule
occupies, never merely because it sits at the same height, because the centre
rail on the transport lane is exactly where people draw and the pitch band's
rules are the octaves. A stroke laid along a printed rail is the one case this
cannot separate, and it reads as the rail.

Each band is registered on its own box rather than on the page alone. The
homography maps the four corner squares exactly, and over 300 mm a printer that
lays the content a hair small or a hair off centre still leaves a millimetre or
two unaccounted for at each end: the first second of a band lands on the gutter
and the last lands inside the frame. So a band looks for its own left and right
sides, which are the only full-height lines it has, and time is measured along
the printed band. The registered picture is cut to the same box, so the paper
sits under the reading rather than beside it.

What the printing hides is put back, where the printing explains it. The rail
labels sit inside each band and a line drawn behind one goes unread, which used
to leave an amplitude silent for the first half second of a piece that was drawn
across the whole sheet. A hole is filled only when every missing column is one
where the line would have been inside printed ink, and only for a short stretch:
the widest thing the sheet prints inside a band is 9 mm, and a longer blank
belongs to the paper.

A scanned timbre is laid again at the weight a brush lays. A pen line is about a
twentieth of the panel high where enamel is a seventh, and the scanning spot is
wider than the pen line: the servo gets a weak, broken edge to ride and the
voice comes out several times quieter than the same shape drawn on screen. The
traced line is redrawn underneath itself at brush weight with pen skips bridged,
which leaves the top edge, the part the spot rides, exactly where it was drawn.

### The paper stays

A lane holds one value per column. That is what the machine reads, and it is
not what anybody drew. A workshop sheet comes back covered in scribbles, words
and faces, and reducing that to a height per column throws away almost all of
it. So an imported sheet keeps its registered photograph and every band shows
the paper, with our reading of it drawn over the top in orange. **Reading** in
the header turns the overlay off, leaving the sheet as it was drawn.

The timbre panels are not read as contours at all. Oram's slides were painted
glass and the flying spot answers to the whole field, so a panel is sampled as a
2-D opacity field and handed to the engine as painted glass. A scribble stays a
scribble, a drawn face stays a face, and the scanner does with them what the
machine did. Read as a single edge and filled underneath, every one of them came
back as the same solid black silhouette.

The threshold sits below what the dashed rules print at, because a workshop runs
on pencil and pencil is nowhere near solid black. Held above the rules it read a
firm biro and missed half of what people actually drew.

## Reading a MIDI file

**Import MIDI** lays a `.mid` file onto the strips. The parser is hand-rolled, so
format 0 and 1, running status and tempo changes anywhere in any track are all
handled, and the package has no DOM and no Node in it like the others.

The interesting part is not the parsing. The machine has one pitch strip and
four amplitude strips, and the four amplitudes are the four timbres of a single
voice rather than four voices. **A chord cannot be represented at all.** Neither
can two parts at different pitches.

So a file is reduced to one line. The highest sounding note wins, which is what
a listener hears as the tune, and the importer reports how many notes it dropped
rather than hiding the loss. The rest goes where it can:

| | |
|---|---|
| pitch | the sounding note as a frequency, so the strip is linear in Hertz and octaves fall unevenly, exactly as the machine has them |
| amplitude | the note's velocity, in the timbre belonging to the part it came from, so an arrangement moving between parts changes timbre |
| vibrato | the modulation wheel, or the pitch bend where there is no wheel. In Delay mode that strip is an echo time instead, so an imported file sets echo times, not vibrato |
| reverberation | the reverb send, CC 91 |
| transport | nothing. A blank transport is normal speed, and the file's tempo is already in the note times |

A file longer than thirty seconds is fitted rather than cut: the note times are
mapped onto the sheet and the transport speed is set so the piece still plays at
its own tempo. Notes above 1000 Hz have no place on the strip and are counted,
not clipped silently.

In Notes mode a MIDI note lands as a note row and an octave row instead, which
is what it already is. Only notes outside octaves 1 to 8 are refused.

## Audio and MIDI out

**Export ▸ Audio** renders one pass of the sheet to a WAV file: the same engine
that plays live, run faster than real time in a worker, so there is nothing to
record and nobody has to press Stop at the right moment. One pass means however
long the speed and the transport strip make it, plus a short tail so the plate
and the light bulbs die away. Sixteen-bit mono, as the machine was, or stereo
with Mono off in the Fidelity bar. The file is
normalised so its loudest moment peaks at -1 dB: the machine leaves room for all
four timbres at once, so a piece using one or two would otherwise come out
barely audible.

**Export ▸ MIDI** comes from the same render. While it runs, the machine is
sampled every ten milliseconds for the pitch the sheet asks for, the pitch that
actually sounds and the level. A note starts when the level comes up and a new
one when the pitch moves more than about half a semitone. What sounded between
the notes goes in as pitch bend (twelve-semitone range, so vibrato fits), and
the level goes in as expression, CC 11, because the machine's loudness is a
contour, not a strike. The file is in time with the WAV.

## Waveform presets

Each timbre has a **Preset** menu: sine, saw and square paint that shape onto
the slide, and **Blank** wipes it to clear glass. A blank slide passes the beam
straight through, so the photocell sees a steady light and that timbre is
silent: a way to take a voice out without drawing its amplitude down to nothing,
and a clean sheet to paint on. **Supersaw** paints a saw and adds six detuned copies, 25 cents
either side. **Detune** leaves the painting alone and adds two copies, 12 cents
either side. The detuned copies are each a scanner of their own reading the same
slide, which the machine never had. They are drawn on the slide as thin orange
lines along each copy's edge, and the tag in the corner (×7 ±25¢) says how many
and how far. Click the tag to go back to one voice.

## The effects strips

Two of the strips can be pointed at something other than what they drove on the
machine. Both switches sit on the lane itself.

**Vibrato or Delay.** As built, strip 8 bends the pitch either side of the
centre line, by up to the amount set in the top bar. Switched to **Delay**, the
same line is an echo time instead: low is 20 ms, high is 1.2 seconds, spaced
exponentially so the useful times are spread out, with guide lines at an eighth,
a quarter, a half and one second. The top bar then sets the feedback. The time
is glided to rather than jumped to, so dragging the line up bends the pitch of
what is already in the echo, the way moving a tape head would. The echoes go
into the reverb send, and keep the pan of whatever made them.

**Plate or Room.** The reverb strip's destination. **Plate** is the steel sheet,
the likeliest thing the send reached in a Workshop of that period. **Room** is
the same tank run at about a third of the size, damped and less smeared, with
early reflections in front of it: an echo chamber rather than a plate. Changing
the space starts the new one empty, so the tail of the old one stops rather than
turning into it.

## The transport strip

Strip 10 drives the clutch: the centre line is normal speed, the top rail
double. The bottom rail is a tenth rather than the dead stop the machine's
clutch could manage. A sheet is thirty seconds long and a workshop is an
afternoon, and a line drawn along the bottom froze the piece with no way back
until the line came up again. Slow enough to hear as a halt, fast enough that
the piece always comes out the other side.

It has no switch of its own: a strip left blank rests on its centre line, and
the centre line is normal speed, so there was nothing for a switch to do.

## Pan

Each timbre has a pan slider, L to R, set once rather than drawn. The machine
was mono, so pan is heard only with **Mono** off in the Fidelity bar; moving a
slider while Mono is on turns it off and says so. The pan is equal power with
the centre at unity, so a centred timbre sounds exactly as it does in mono. The
plate reverb stays mono and returns to both sides. With Mono off, an audio
export is stereo. Double-click a slider to centre it.

## Paper

The sheet is US Legal, 8.5 x 14 landscape, because 300 mm of field is what
makes a second a centimetre and a sheet thirty seconds. **Export ▸ Sheet,
Letter** prints the same sheet on 8.5 x 11 instead: the whole drawing, shrunk
evenly to about 79%, so a Letter sheet still holds a whole 30-second piece at
roughly 8 mm to the second. The printed ruler still reads in seconds.

Evenly, in both directions, rather than squeezed to fit the narrower page: that
keeps the type readable and the QR square. It also means the importer needs to
know nothing about it. The four corner squares come back as a smaller copy of
the same rectangle, and undoing that is the same arithmetic as undoing print
scale and camera angle, which registration does anyway. A Letter sheet and a
Legal one read back the same piece.

## Drawing tools

Five tools, on the tool bar: **draw** and **erase** are freehand, and **line**,
**curve** and **arc** are placed rather than drawn. Press where a mark starts,
drag, and release where it ends; what lies between is worked out. A line is the
shortest way between the two values. A curve eases out of the first and into
the second, which is what a hand drawing a swell does and what an amplitude
usually wants. An arc is the exponential between them, worked out in equal
steps of decibels rather than equal steps of height: steep at the loud end and
flattening towards silence, which is how a sound dies away and how a fade
sounds even when the line looks wrong. It bends towards the quieter end
whichever way it is drawn. Hold **shift** and the angle snaps to one of sixteen, every
22.5 degrees, measured on screen rather than in the data: a lane is wide and
short, so the same pair of numbers is a gentle slope to look at and a cliff to
the machine. A mark that would leave the band flattens along the rail, since
there is no value above full or below silence.

The mark is dashed while you aim it and only written to the lane when you let
go. The timbre slides are painted with a brush rather than drawn with these.

## Themes

Six, under the palette: Paper, Sepia and Blueprint are light, Charcoal,
Midnight and Phosphor are dark. ⌘D steps through them. The choice is kept, and
the shell is told which background to paint the window before the page loads,
so a dark theme on a light desktop still opens without a flash.

A theme is one block of custom properties in `app/src/ui/styles.css` and one
entry in `app/src/ui/theme.ts`. The drawing surfaces are canvases and read the
same properties back at paint time, so a new palette reaches them without any
further work. Its background also belongs in the short list in `index.html`,
which carries the first frame.

## Working with a scanned timbre

A scan reads a drawn waveform through a threshold, and a threshold turns a pen
line into a staircase: edges the scanner hears as harmonics nobody drew, and a
join between the last column and the first that clicks once per cycle. **Smooth
it**, at the foot of a timbre's shape menu, traces the stroke, rounds it off,
bridges what the pen missed and takes out the offset so the cycle passes
through zero. It wraps rather than stopping at the ends, which is what makes
the join silent. On a workshop sheet it halved the roughness and brought every
cycle onto the zero line.

**Slip** gives a timbre a clock of its own. Four slides driven from one pitch
sit exactly on top of each other, which is tidier than any tape machine
managed; slip lets each wander by up to a few per cent in a slow random walk,
so the voices drift apart and back. Steady, drift, wander, loose.

## Taking a piece apart

Every strip has a **mute**, so a piece can be heard a part at a time. A muted
strip keeps its drawing and the engine is handed blank paper for it, which
already means something sensible on every lane: silence on an amplitude, no
wobble on vibrato, normal speed on the transport.

The **trash** opens a list: everything, which asks first, or one strip at a
time, which does not.

Each timbre can also sit up to two octaves off the note, which is the one way
this instrument has of sounding more than one pitch at once. The machine had a
single pitch for the whole voice.

## Starting again

**Clear**, or File ▸ New (⌘N), blanks every strip, paints four fresh slides and
puts every setting back to the machine as built: Hertz pitch, vibrato rather
than delay, plate rather than room, mono, one voice per timbre, everything
centred. Any imported paper goes with it. There is no undo, so it asks first.

## Picking up where you left off

The session is kept as you work and restored at launch: the drawing, the slides
and the settings, written a second after each change and again as the window
closes. It lives in the app's data folder as `autosave.daphne`, the same format
as a saved file. A photographed sheet's paper backdrop is not kept, only what
was read off it.

## The projector

**Projector** (⇧⌘P) opens a second window full screen on the external display,
or as a window if there is only one. It shows every lane with the read heads
moving, and in Notes mode the rows and the reading. It holds no state of its
own: the editor sends it everything when it opens and every change after.

## The performance file

**Save** and **Open** read and write `.daphne` files. They hold what was drawn,
not the scan it came from: by the time a lane reaches the file, a drawn one and
one lifted off a photographed sheet are the same thing.

The format is plain JSON, one object, no framing and no compression. A workshop
produces material that outlives the software that made it, so the file has to be
readable in a text editor without this app. Lane samples are 0 to 1 with `null`
where nothing was drawn, since blank paper is not the same as a line at the
bottom of the band. Stroke ranges say which marks were separate. The four
painted slides are the one concession: 512 x 256 opacity fields written as
base64, one byte per pixel, with the layout named in the file.

```json
{
  "format": "daphne-performance",
  "version": 1,
  "duration": 30,
  "columns": 3000,
  "lanes": {
    "pitch": { "values": [null, 0.5], "strokes": [[120, 480]] }
  },
  "slides": [{ "width": 512, "height": 256, "layout": "row-major-u8", "opacity": "..." }],
  "settings": {
    "globalSpeed": 1, "vibratoCents": 50, "fidelity": {},
    "pitchMode": "hertz", "markMode": "lines", "root": 0, "scale": "chromatic"
  }
}
```

A file written at a different lane resolution or glass size is resampled on the
way in, and a lane the file does not carry loads blank rather than failing the
whole load. See [`packages/app/src/session.ts`](packages/app/src/session.ts).

## Status

Working: the voice, the printable sheets, in-app drawing and painting, the slide
randomiser, live audio, the projector window, plate reverb, the transport strip,
save and open, a zoomable timeline, PDF export back onto the same template,
importing a photograph or scan of a marked-up sheet, importing MIDI, pitch as
notes and octaves with a key and scale, audio and MIDI export, waveform
presets, and the session kept between launches.

The loop closes: draw, print, let somebody mark it up by hand, photograph it,
hear what they drew.

Not yet: a watch folder, so a phone dropping photos into a shared folder imports
them without anyone touching the machine.

## Releases

Tag and push. GitHub Actions builds macOS, Windows and Linux on their own
runners and publishes a draft release.

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Cross-compiling from one host is possible but fragile, since Windows installers
want wine and Linux AppImages want their own tooling, and those failures surface
late.

To build locally for the current platform only:

```bash
pnpm dist                                          # installers
pnpm --filter @oramics/shell run build:dir         # unpacked app, faster
```

`stage.mjs` copies the Vite build into `packages/shell/renderer` first, so the
packaged app is self-contained. The whole bundle is `main.cjs`, `preload.cjs`
and the renderer, with no `node_modules` at all. Vite has already bundled
everything the renderer uses and the shell has no runtime dependencies, which
avoids the usual pnpm and electron-builder hoisting problems.

The icon is generated rather than committed. `pnpm icon` writes
`packages/shell/build-resources/icon.png` and electron-builder converts it.

### Signing

The macOS build signs and notarises itself when the credentials are present,
and builds unsigned when they are not, so a clone without an Apple account
still works. See `packages/shell/electron-builder.config.js`.

Signing needs a **Developer ID Application** certificate. This is a different
thing from the Apple Development and Apple Distribution certificates Xcode
creates for you: those are for debugging and for the Mac App Store, and neither
one works for a DMG people download. Only the team's Account Holder can create
a Developer ID certificate.

The exported `.p12` holds the private key. Do not commit it, to this repo or
any other. Git history is permanent, so deleting it in a later commit does not
remove it, and a leaked Developer ID key lets someone sign software as you until
Apple revokes the certificate, which breaks every build already shipped.

Keep three copies: your keychain (where local signing reads it from), GitHub
Actions secrets (base64, for CI), and an offline backup with the export
password. Losing the private key means you cannot sign updates to anything you
have already released.

Treat the exported file as temporary. Upload it and delete it:

```bash
gh secret set APPLE_CERT_P12 < <(base64 -i ~/Downloads/developer-id.p12)
rm ~/Downloads/developer-id.p12
```

Five repository secrets switch signing on:

| Secret | Where it comes from |
|---|---|
| `APPLE_CERT_P12` | Keychain Access, My Certificates, right-click the Developer ID certificate, Export. Base64 the file. |
| `APPLE_CERT_PASSWORD` | You invent it. The export dialog asks you to set a password on the .p12. Apple does not issue this. |
| `APPLE_ID` | Your Apple ID email address. |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com, Sign-In and Security, App-Specific Passwords. Looks like `abcd-efgh-ijkl-mnop`. Your normal account password does not work. |
| `APPLE_TEAM_ID` | developer.apple.com, Membership. Ten characters. |

Three passwords come up while doing this and they are easy to mix up. Your Mac
login password unlocks the keychain so the export can happen, and is not stored
anywhere. `APPLE_CERT_PASSWORD` is one you make up, and only protects that file.
`APPLE_APP_SPECIFIC_PASSWORD` is generated by Apple and is the only one of the
three that notarising uses.

Notarising matters as much as signing. A signed but unnotarised app is still
blocked on any machine that has not seen it before. The release workflow runs
`codesign`, `spctl` and `stapler validate` afterwards and prints the results,
because the difference is invisible until someone else tries to open it.

Windows builds are unsigned, so SmartScreen shows a warning users can click
through. Certificates now have to live on hardware or in a cloud HSM, which
puts them at roughly $200 to $400 a year.

Until macOS signing is switched on, Gatekeeper refuses the app unless you
right-click and Open once, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Daphne.app
```

## Licence and attribution

GPL-3.0. See [LICENSE](LICENSE).

This is an independent reconstruction. It is not affiliated with the Daphne Oram
Trust, Goldsmiths, or the Science Museum. It is built from published accounts of
the machine, chiefly Graham Wrench's. Every departure from what those accounts
describe is marked in the code and switchable in the app.

## Known environment quirk

On macOS, electron's postinstall sometimes produces a 250 KB `dist` instead of
the real 250 MB one. `extract-zip` does not handle the symlinks inside
`Electron.app` and gives up silently with a zero exit code. You get:

```
Error: Electron failed to install correctly, please delete node_modules/electron
```

The download is fine and already cached. Only the extract failed. Repair it:

```bash
pnpm fix:electron
```
