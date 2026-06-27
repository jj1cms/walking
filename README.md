# Walking Tracker PWA

A GPS-based walking tracker web app (PWA) designed for iPhone.
Enter your body weight and the app estimates calories burned based on distance and time walked.

- 📍 **Real-time GPS tracking** — Records your route on a map as you walk
- 🗺 **Free map tiles** — Powered by OpenStreetMap (no API key or billing required)
- 🔥 **Calorie estimation** — Calculated using body weight × speed (MET method)
- 🔒 **Privacy-first** — All data stays on your device. Nothing is sent externally. Optional PIN lock.
- 📲 **Add to Home Screen** — Runs fullscreen like a native app / works offline

---

## Installation (iPhone)

1. Open the app URL (e.g. `https://jj1cms.github.io/walking/`) in **Safari** on your iPhone
2. Tap the Share button → **"Add to Home Screen"**
3. Launch the app from the home screen icon
4. On first launch, **enter your body weight in the Settings tab**
5. Go to the **Measure tab** → tap **"Start"** → tap **"Stop"** when done

> When prompted for location access, tap **"Allow"**.
> Tracking runs while Safari / the PWA is open. Due to web limitations, background tracking is not available — please keep the screen on while walking.

---

## Publishing to GitHub Pages

Place all files in a GitHub repository under your account (`jj1cms`) and enable GitHub Pages to publish.

### 1. Create a repository
Create a new repository on GitHub (e.g. `walking`).

### 2. Push the files
Run the following in this folder (replace `<repo>` with your repository name):

```bash
git init
git add .
git commit -m "Walking Tracker PWA"
git branch -M main
git remote add origin https://github.com/jj1cms/<repo>.git
git push -u origin main
```

### 3. Enable GitHub Pages
In your repository, go to **Settings → Pages**:
- **Source**: `Deploy from a branch`
- **Branch**: `main` / `(root)` → click **Save**

After a few minutes, the app will be live at `https://jj1cms.github.io/<repo>/` (HTTPS is required for GPS to work).

---

## Privacy & Security

- **Data stays on your device**: Body weight, walk history, and routes are stored in the browser's `localStorage` only. Nothing is sent to any server or cloud. Even though the app itself is publicly hosted on GitHub Pages, **your records are never visible to others** (they exist only in your device's local storage).
- **PIN lock (optional)**: You can enable a 4–8 digit PIN in Settings. The PIN is not stored in plain text — it is hashed with `PBKDF2` (Web Crypto API).
- **HTTPS**: GitHub Pages always uses HTTPS. The Geolocation API also requires HTTPS.
- **Delete all data**: A one-tap option to erase all data is available in Settings.
- **Map tiles**: Map images are loaded from OpenStreetMap servers, which means the approximate area you are viewing is shared with the tile server. Your weight or walk records are never sent.

> For stronger protection, use your iPhone's built-in screen lock (Face ID / Passcode).

---

## iOS Home Screen Icon (Optional)

The PWA works with the default SVG icon, but for a crisp icon on the iOS home screen:

1. Open `generate-icons.html` from your published URL (e.g. `.../walking/generate-icons.html`)
2. Download `icon-192.png`, `icon-512.png`, and `apple-touch-icon.png`
3. Save them to the `icons/` folder and add the following to `<head>`, then re-push:
   ```html
   <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
   ```

---

## File Structure

```
.
├── index.html              Main app
├── css/styles.css          Styles
├── js/app.js               Tracking, map, and calorie logic
├── manifest.webmanifest    PWA configuration
├── service-worker.js       Offline support
├── icons/icon.svg          App icon
├── generate-icons.html     PNG icon generator for iOS (optional)
└── .nojekyll               For GitHub Pages
```

---

## How Calculations Work

- **Distance**: GPS coordinates are accumulated using the Haversine (spherical) formula. Low-accuracy fixes (>35 m), GPS noise (<3 m micro-movements), and GPS jumps (>43 km/h) are filtered out to reduce error.
- **Calories**: Calculated per segment as `METs × weight (kg) × time (h)`. METs vary from 2.0 to 7.0 depending on walking speed. Results are estimates.

---

## Running Locally

PWA / Service Worker does not work correctly over `file://`. Use a local server:

```bash
npx serve .
# Open the displayed URL in your browser
```
