# AWS static deployment

This project can run without EC2 by serving the player, `tracks.json`, and music files from S3 through CloudFront.

## Target layout

```text
s3://YOUR_BUCKET/
  index.html
  app.js
  styles.css
  favicon.png
  tracks.json
  music/
    Artist - Song.mp3
    Artist - Song.lrc
    Artist - Song.jpg
```

The browser loads `tracks.json`. Each track points at an audio file, optional lyric file, and optional artwork file.

## Build the static player

```bash
npm run build:static
```

The build output is:

```text
dist/music-player-static-v0.1.0/
```

Generate a real manifest from your local music folder:

```bash
node scripts/generate-tracks-json.mjs "/Users/xingdawang/Music/Converted Music" \
  --prefix "./music/" \
  --output "dist/music-player-static-v0.1.0/tracks.json"
```

## Recommended AWS setup

Use a private S3 bucket and a CloudFront distribution with Origin Access Control (OAC). AWS recommends OAC over the older OAI model for S3 origins:

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html

Use a regular S3 bucket origin in CloudFront, not the S3 static website endpoint, if you want OAC. AWS documents that OAC is for regular S3 bucket origins:

https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html

## Upload

Replace `YOUR_BUCKET` and `YOUR_DISTRIBUTION_ID`.

Upload the player shell with short cache for entry files:

```bash
aws s3 cp dist/music-player-static-v0.1.0/index.html s3://YOUR_BUCKET/index.html \
  --cache-control "no-cache" \
  --content-type "text/html"

aws s3 cp dist/music-player-static-v0.1.0/tracks.json s3://YOUR_BUCKET/tracks.json \
  --cache-control "no-cache" \
  --content-type "application/json"
```

Upload static assets with a long cache:

```bash
aws s3 cp dist/music-player-static-v0.1.0/app.js s3://YOUR_BUCKET/app.js \
  --cache-control "public,max-age=31536000,immutable" \
  --content-type "text/javascript"

aws s3 cp dist/music-player-static-v0.1.0/styles.css s3://YOUR_BUCKET/styles.css \
  --cache-control "public,max-age=31536000,immutable" \
  --content-type "text/css"

aws s3 cp dist/music-player-static-v0.1.0/favicon.png s3://YOUR_BUCKET/favicon.png \
  --cache-control "public,max-age=31536000,immutable" \
  --content-type "image/png"
```

Upload music, lyrics, and artwork:

```bash
aws s3 sync "/Users/xingdawang/Music/Converted Music" s3://YOUR_BUCKET/music/ \
  --exclude "*" \
  --include "*.mp3" \
  --include "*.flac" \
  --include "*.wav" \
  --include "*.m4a" \
  --include "*.ogg" \
  --include "*.aac" \
  --include "*.lrc" \
  --include "*.jpg" \
  --include "*.jpeg" \
  --include "*.png" \
  --include "*.webp" \
  --cache-control "public,max-age=31536000,immutable"
```

After upload, invalidate CloudFront entry files:

```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/index.html" "/tracks.json"
```

## Notes

- If the player and music are served from the same CloudFront domain, no CORS configuration is needed.
- If `tracks.json` points directly to another S3 or CloudFront domain, configure CORS for audio, lyrics, and artwork.
- For streaming, keep music in S3 Standard at first. Infrequent Access and Glacier classes can add retrieval costs or delays.
- The browser will use HTTP range requests for seeking. S3 supports range reads through `GetObject`.
