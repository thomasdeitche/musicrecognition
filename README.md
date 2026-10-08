# Musikerkennung

Erkennt live laufende Songs (Mikrofon oder Systemaudio) und zeigt Künstler, Titel und
Erstveröffentlichung inkl. aktuellem Alter in Jahren und Monaten.

## Start

`start.bat` doppelklicken → Browser öffnet http://localhost:3000/ → „Start“ → Mikrofonzugriff erlauben.
Das schwarze Konsolenfenster ist der Server – offen lassen, solange die App genutzt wird.

## Auf einen anderen PC übertragen

Den kompletten Ordner `musicrecognition` kopieren (USB-Stick, Netzlaufwerk …) und dort `start.bat` starten.
Es muss nichts installiert werden: `runtime\node.exe` (Node.js) und `node_modules` sind enthalten.
Voraussetzungen am Ziel-PC: Windows 64 Bit, Internetzugang, Mikrofon.
Wird `start.bat` ein zweites Mal gestartet, öffnet sie nur den Browser.

## Audioquelle

- **Mikrofon**: Standard oder ein bestimmter Eingang aus der Liste.
- **Musik vom PC selbst** (Firefox): unter Windows „Stereomix“ aktivieren
  (Systemsteuerung → Sound → Aufnahme → Rechtsklick → Deaktivierte Geräte anzeigen) und in der Liste wählen.
- **Systemaudio-Button** (nur Chrome/Edge): Tab- oder Bildschirmton freigeben.

## Ablauf

- Der Browser nimmt fortlaufend auf, rechnet auf 16 kHz mono herunter und schickt alle 5 s
  die letzten 10 s an den lokalen Server (`server.js`).
- Der Server erkennt den Song über Shazam (Bibliothek `shazam-api`, kein API-Key nötig).
- Releasedatum: frühestes passendes Datum aus iTunes-Suche und MusicBrainz (gleicher Künstler +
  Titel), damit Remaster/Compilations nicht das Original verdrängen. Ergebnis wird pro Song gecacht.
- Nach einem Treffer wird alle 20 s geprüft, ob ein neuer Song läuft.

Hinweis: Das kurze Audio-Fingerprint (kein Rohton) geht an Shazam; die Datumsabfrage an
itunes.apple.com und musicbrainz.org. Der Server lauscht nur auf 127.0.0.1.

## Konfiguration

Umgebungsvariablen `PORT` (Standard 3000) und `HOST` (Standard 127.0.0.1).
