# Joy-Con Readers

Joy-Con band readers for the Nintendo NFC games, at
**http://joy-con-readers.nintendovibes.com**.

## How it works

One screen with a card per game (Thwomp Panel Panic and DK Spin). On each
card, connect a right Joy-Con (Switch 1 or Switch 2); every band tapped on it
is posted to the shared API under that game's **station**, and only that game
reacts (it polls `/last-nfc?station=<station>`).

- Each Joy-Con shows its card's player lights: one light for Thwomp, two for
  DK Spin.
- The page remembers which Joy-Con is which (a Switch 1 Joy-Con by its
  Bluetooth address, a Switch 2 Joy-Con by Chrome's device id) and gives each
  one back to its game when it reconnects or the page reloads.
- A connected Switch 1 Joy-Con with no game yet is listed under "Joy-Cons
  without a game", with a button per game.
- To add a game, add it to `STATIONS` in `src/stations.js` and have the
  game poll its station.

Open it in Chrome on the Mac and leave the tab open.

## Letting Chrome use Bluetooth here

Web Bluetooth (Switch 2 Joy-Con) and WebHID (Switch 1 Joy-Con) only work on
pages Chrome treats as secure. The simple way (the same as Bowser Jr): in
Chrome on the Mac, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://joy-con-readers.nintendovibes.com`, set it to Enabled and relaunch.
The Route allows plain http for this. If Chrome ever resets the flag after an
update, add it again.

## Deploying (first time)

1. Create an empty GitHub repo `nintendovibes/joy-con-readers` and push this
   folder (`git remote add origin git@github.com:nintendovibes/joy-con-readers.git`
   then `git push -u origin master`). The image name in `k8s/` assumes that
   repo name.
2. The GitHub Action builds the image, pushes it to GHCR and writes the new
   tag into `k8s/kustomization.yaml`, the same as Thwomp Panel Panic.
3. Add an Argo CD Application for this repo's `k8s/` folder (namespace
   `nintendo`), like Thwomp's, or run `oc apply -k k8s/`.

After that, every push to `master` redeploys automatically.

## Local development

```sh
npm install
npm run dev     # https://172.16.122.81:5181, like Bowser Jr's dev server
```

Copy `server.crt` and `server.key` from `../Bowser Jr/certs/` into `certs/`
(git-ignored) first; the Mac already trusts that certificate. Without them
the dev server runs on plain http.

In dev, the reader also sends its log to `logs/joy-con-readers.jsonl` on the PC.

## Code

- `src/App.jsx`: the screen (a card per game).
- `src/stations.js`: which Joy-Con reads for which game; connects, reconnects, posts taps.
- `src/joycon1/JoyCon1.js`: Switch 1 Joy-Con NFC over WebHID.
- `src/joycon2/`: Switch 2 Joy-Con over Web Bluetooth (copied from Bowser Jr).
