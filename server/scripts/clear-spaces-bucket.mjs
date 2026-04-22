// One-shot bucket purge — deletes every object in SPACES_BUCKET.
// Reads credentials from env (so secrets never land on disk in this repo).
// Usage:
//   SPACES_ACCESS_KEY_ID=... SPACES_SECRET_ACCESS_KEY=... SPACES_BUCKET=montr-media \
//     SPACES_ENDPOINT=https://sfo3.digitaloceanspaces.com SPACES_REGION=us-east-1 \
//     node server/scripts/clear-spaces-bucket.mjs

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const {
  SPACES_ACCESS_KEY_ID,
  SPACES_SECRET_ACCESS_KEY,
  SPACES_BUCKET,
  SPACES_ENDPOINT,
  SPACES_REGION = 'us-east-1',
  DRY_RUN,
} = process.env;

for (const [k, v] of Object.entries({
  SPACES_ACCESS_KEY_ID,
  SPACES_SECRET_ACCESS_KEY,
  SPACES_BUCKET,
  SPACES_ENDPOINT,
})) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const client = new S3Client({
  endpoint: SPACES_ENDPOINT,
  region: SPACES_REGION,
  credentials: { accessKeyId: SPACES_ACCESS_KEY_ID, secretAccessKey: SPACES_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

let continuationToken;
let totalDeleted = 0;
let pageCount = 0;
do {
  const list = await client.send(
    new ListObjectsV2Command({
      Bucket: SPACES_BUCKET,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    })
  );
  const objects = list.Contents ?? [];
  pageCount += 1;
  console.log(`page ${pageCount}: ${objects.length} object(s)`);

  if (objects.length === 0) break;

  if (DRY_RUN) {
    for (const o of objects) console.log(`  DRY_RUN would delete: ${o.Key} (${o.Size}B)`);
  } else {
    const del = await client.send(
      new DeleteObjectsCommand({
        Bucket: SPACES_BUCKET,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key })), Quiet: true },
      })
    );
    totalDeleted += objects.length;
    if (del.Errors && del.Errors.length > 0) {
      console.error(`  ${del.Errors.length} delete error(s):`);
      for (const e of del.Errors) console.error(`    ${e.Key}: ${e.Code} ${e.Message}`);
    }
  }

  continuationToken = list.NextContinuationToken;
} while (continuationToken);

console.log(`\n${DRY_RUN ? 'Would delete' : 'Deleted'} ${totalDeleted} object(s) total from ${SPACES_BUCKET}.`);
