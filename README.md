# Addy

A field web app for GIS teams. It does two jobs:

1. **Collect**: record classified ground points (training samples for land-cover / mining / habitat classification).
2. **Ground truth**: upload validation points (CSV, GeoJSON or KML), walk to each with an arrow and distance alarm, record what is really on the ground, and record **new points** you come across on the way.

Everything is saved on the phone first and syncs to your team server when there is signal. All collected points download as **CSV, GeoJSON, KML or GPX** for QGIS, ArcGIS, R, Google Earth Engine or Google Earth. Validation datasets that include the map's class produce a **confusion matrix, overall accuracy (with 95% interval), Cohen's kappa, and user's and producer's accuracy**.

## Start it

You need Node.js 22.5 or newer (this computer has v24). There is nothing to install.

- Double-click **`Start Addy.bat`**, or run `npm start` in this folder.
- Open http://localhost:8080. On first run you create the **admin** account.
- Menu → **Manage team** to add people. Roles:
  - **Collector**: records points and visits, and can edit only their own points.
  - **Manager**: also creates and edits projects and class lists, uploads and removes validation datasets, and edits anyone's points.
  - **Admin**: also adds people, resets passwords and disables accounts.

### Phones (GPS needs HTTPS)

Browsers only allow GPS on `https://` pages or on `localhost`. To use phones on the same Wi-Fi as this computer:

1. Run `npm run cert` once. This needs `openssl`, which comes with Git for Windows. It creates a self-signed certificate in `certs/`.
2. Restart the server. It prints addresses such as `https://192.168.1.20:8443`.
3. On each phone, open that address, accept the browser's certificate warning once, then use **Add to Home screen**. The app then opens full screen and works offline.

For teams spread across sites, host it online, for example on Render as a Node web service with the start command `npm start` and a persistent disk mounted at `/data`, with the environment variable `DATA_DIR=/data`. The host then provides HTTPS.

## Field workflow

**Set up (manager):** Menu → New project. Pick a class scheme (general LULC, mining, forest condition, habitat), then edit the list. Each line is `code, name, #colour`. Use the same integer codes as your classifier.

**Collect training samples:** Start GPS, stand in a homogeneous patch, tap **Record**, choose the class, and save. **Average fixes** takes 5–60 fixes (Menu sets how many) and stores the mean position and its spread. **Use map centre** places a point at the crosshair, for example from imagery. The record form also takes confidence, a homogeneous-area radius, notes and a photo (resized on the phone).

**Ground truth:**

1. Data → **Upload points file**. The app guesses the ID, latitude/longitude or UTM easting/northing (pick the zone; Ghana is 30N), and mapped-class columns. The mapped class can be a class name or a class code.
2. The app switches to **Ground truth**. Tap **Nearest**. The card shows the arrow, distance and bearing, and turns amber at 200 m and orange at 50 m. It goes green at the arrival distance (20 m by default), with a beep and a vibration.
3. Tap **Verify**. Choose *Reached*, *Seen from a distance* or *Could not reach*, then the class on the ground. The app records whether it **agrees with the map** and moves you to the next nearest target.
4. Found something worth recording on the way? Tap **New point** (or "Record a new point here instead"). It is saved as a `new` point with its own label.

**Road routing:** In Ground truth mode, the route to the target follows OpenStreetMap roads. The banner shows the distance and time left, your arrival time, and the stages ("Walk 400 m to the road, then 12 km by road, then 800 m off-road to the point"). The arrow points along the road ahead, and the route re-plans as you move.

- **Before going to the field**, open Map layers → Roads for routing → **Download** while you have a connection. Addy downloads the OSM roads, tracks and footpaths for the whole project area (all targets, points and reference layers plus about 4 km around them) and saves them on the device. Routes are then calculated on the phone, with no signal needed. Addy also tries this automatically the first time you pick a target.
- **Your own road data:** Map layers → Import accepts GeoJSON or KML lines (for example roads exported from QGIS or a Geofabrik shapefile; `highway` and `fclass` attributes are understood), `.osm` files, or Overpass JSON. Coordinates must be WGS84.
- **Travel mode** (tap the mode button in the banner, or Settings): Walk, Motorbike or Car. Vehicles keep to roads they can use and respect one-way streets; off-road stretches at either end are always walked. Speeds assumed (km/h): off-road 2.5; walking 4.5 on roads, about 3.6 on paths. Motorbike: 15–70 depending on road class (tracks 18). Car: 10–90 (tracks 12).
- **Sense check:** if walking straight is quicker than any road route (common inside forest reserves), Addy says so and points straight at the target. Within 60 m of the target it always points straight.
- **Online fallback:** if no roads are saved for the area, Addy asks the public OSRM service at routing.openstreetmap.de. This sends your position and the target to that service; switch it off under Settings → Online routing.
- The public Overpass servers that provide road downloads are sometimes overloaded. Addy tries four servers in turn; if all are busy, wait a few minutes and press Download again.

**Report:** Data → Open accuracy report. It shows samples per class (classes under 50 are flagged), progress per dataset, the confusion matrix and accuracy figures, and a per-person tally. **Download matrix (CSV)** saves the matrix; **Show disagreements** lists the points where ground and map differ.

**Export:** Data → Export. You can pick all points, training only, validation visits, new points, or only your own. Coordinates are WGS84 (EPSG:4326), with UTM zone, easting and northing columns added. Export columns include class, class_code, accuracy, number of fixes, spread, source, mapped class, agree, distance to target, observer and time. Tick "include targets not visited" to export the remaining targets as well.

**Other:** You can add a study-area boundary or other GeoJSON/KML file as a reference layer. The app records your GPS track, which you can export as GPX. Satellite and topographic map areas you have viewed stay available offline (OpenStreetMap street tiles are not stored offline, per the OSM tile usage policy; use Map layers → Show saved roads instead). Base maps: streets, satellite, satellite with labels, and topographic.

## Samples

- `samples/atewa_ground_truth_points.csv`: the 88 Atewa ground-truth points (lat/lon), ready to upload.
- `samples/atewa_reserve_boundary.geojson`: the Atewa Range Forest Reserve boundary, to add as a reference layer.

## Data and backup

All team data is stored in `data/addy.db`, a single SQLite file. To back up, copy this file while the server is stopped. Each phone also keeps its own copy until the data is synced.

## Files

```
server.js            accounts, projects, sync API, static files (no dependencies)
make-cert.js         self-signed HTTPS certificate for phones on Wi-Fi
public/index.html    app screens
public/app.css       styles (light and dark)
public/js/app.js     app logic
public/js/geo.js     distance, bearing, WGS84 <-> UTM, fix averaging
public/js/io.js      CSV / GeoJSON / KML / GPX import and export
public/js/db.js      on-device storage (IndexedDB)
public/js/presets.js class schemes
public/js/route.js   road network, offline routing, travel times, road downloads
public/sw.js         offline cache
```
