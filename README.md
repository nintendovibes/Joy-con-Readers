# Nintendo Vibes

Shared pages for the Nintendo NFC games, at
**http://nintendo-vibes.nintendovibes.com**.

## Joy-Con readers

`/joycon?station=<station>` turns a right Joy-Con (Switch 1 or Switch 2) into a
Power-Up Band reader for one game. Every tap is posted to the shared API under
that station, and only the game polling that station reacts:

| Game | Address |
|---|---|
| DK Spin | `http://nintendo-vibes.nintendovibes.com/joycon?station=dk-spin` |
| Thwomp Panel Panic | `http://nintendo-vibes.nintendovibes.com/joycon?station=thwomp` |

Open it in Chrome or Edge on a computer with Bluetooth (the Mac), bookmark the
address for the game, and keep the tab open. Several tabs with different
stations can run at once, each with its own Joy-Con. To add a game, add it to
`KNOWN_STATIONS` in `src/reader.js` and have the game poll
`/last-nfc?station=<station>`.

## Letting Chrome use Bluetooth here

Web Bluetooth (Switch 2 Joy-Con) and WebHID (Switch 1 Joy-Con) only work on
pages Chrome treats as secure. The simple way (the same as Bowser Jr): in
Chrome on the Mac, open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://nintendo-vibes.nintendovibes.com`, set it to Enabled and relaunch.
The Route allows plain http for this. If Chrome ever resets the flag after an
update, add it again.

The alternative is a trusted certificate: nintendovibes.com only exists on the home
network, so no public certificate authority can issue it a certificate.
Instead there's a private **Nintendo Vibes CA** whose name constraints only
let it vouch for `nintendovibes.com` names.

- `scripts/make-nintendovibes-cert.sh` creates the CA and a
  `*.nintendovibes.com` certificate in `../nintendovibes-certs/` (outside
  git; the keys never leave this PC).
- `scripts/apply-route-cert.sh [route ...]` attaches that certificate to
  OpenShift Routes (default: `nintendo-vibes`).

**Trust the CA once on each Mac / iPad that opens a reader:** download
`https://nintendo-vibes.nintendovibes.com/nintendovibes-ca.crt` (proceed past
the warning the first time), open it, add it to the **login** keychain, then
in Keychain Access set **Nintendo Vibes CA → Trust → Always Trust**. Quit and
reopen Chrome.

## Deploying (first time)

1. Create an empty GitHub repo `nintendovibes/nintendo-vibes` and push this
   folder (`git remote add origin git@github.com:nintendovibes/nintendo-vibes.git`
   then `git push -u origin master`). The image name in `k8s/` assumes that
   repo name.
2. The GitHub Action builds the image, pushes it to GHCR and writes the new
   tag into `k8s/kustomization.yaml`, the same as Thwomp Panel Panic.
3. Add an Argo CD Application for this repo's `k8s/` folder (namespace
   `nintendo`), like Thwomp's, or run `oc apply -k k8s/`.
4. Attach the certificate: `bash scripts/apply-route-cert.sh`.
   If Argo CD self-heals this app, add to its Application spec so it doesn't
   strip the certificate:

   ```yaml
   ignoreDifferences:
     - group: route.openshift.io
       kind: Route
       name: nintendo-vibes
       jsonPointers:
         - /spec/tls/certificate
         - /spec/tls/key
         - /spec/tls/caCertificate
   ```

After that, every push to `master` redeploys automatically.

## Local development

```sh
npm install
npm run dev     # https://172.16.122.81:5181 (uses certs/, the Bowser Jr dev CA)
```

In dev, the reader also sends its log to `logs/nintendo-vibes.jsonl` on the PC.

## Code

- `src/App.jsx`: home page and the reader page.
- `src/reader.js`: connects the Joy-Con, reconnects it, posts taps.
- `src/joycon1/JoyCon1.js`: Switch 1 Joy-Con NFC over WebHID.
- `src/joycon2/`: Switch 2 Joy-Con over Web Bluetooth (copied from Bowser Jr).
