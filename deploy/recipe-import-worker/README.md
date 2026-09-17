# Recipe Import Worker (Cloud Run)

The container that runs the heavy half of recipe import. It exists because
yt-dlp and ffmpeg are binaries and a standard Cloud Functions image does not
have them.

Firebase keeps: authentication, job creation, Firestore state, billing, and
the client-facing status endpoint. This service keeps: yt-dlp, ffmpeg, the
video analyzers, and the CPU/disk burn that goes with them.

The seam that makes this possible is `functions/recipeImport/workerRuntime.js`.
The worker is the same code whether it is invoked by a Firestore trigger or by
this container; only the transport changed.

---

## 1. Build and push

From the repo root:

`gcf-artifacts` already exists in this project — Firebase Functions created it.
Reuse it. Do not create a new repository.

```bash
PROJECT=forkast-da914
REGISTRY=us-central1-docker.pkg.dev/$PROJECT/gcf-artifacts
IMAGE=$REGISTRY/recipe-import-worker:$(git rev-parse --short HEAD)

gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

# Pin the artifact checksum in production. Find it at
# https://github.com/yt-dlp/yt-dlp/releases/tag/<YTDLP_VERSION>
docker build \
  -f deploy/recipe-import-worker/Dockerfile \
  --build-arg YTDLP_VERSION=2026.03.17 \
  --build-arg YTDLP_SHA256=<sha256-of-the-standalone-binary> \
  -t $IMAGE .

docker push $IMAGE
```

Verify the tooling landed:

```bash
docker run --rm $IMAGE /bin/sh -c "yt-dlp --version && ffmpeg -version -hide_banner | head -1"
```

## 2. Pick an auth mode — read this before you deploy

The dispatcher and the worker must agree. **Mixing the two modes is the single
easiest way to end up with a worker that returns 403 forever.**

| | Mode A — shared secret | Mode B — OIDC |
|---|---|---|
| Cloud Run IAM | `--allow-unauthenticated` | `--no-allow-unauthenticated` |
| What the caller sends | `x-recipe-import-token: <secret>` | `Authorization: Bearer <id token>` |
| Who checks it | Our worker code | Cloud Run's IAM layer |
| New service accounts | none | 1 invoker SA |
| New IAM bindings | none | 2 |
| Extra npm dep needed | none | `google-auth-library` |
| Secret rotation | manual | automatic (tokens expire) |

**The trap:** in Mode A the dispatcher sends no `Authorization` header. If
Cloud Run is deployed with `--no-allow-unauthenticated`, the request is
rejected at the platform before our code ever runs, and the worker logs look
empty. Mode A only works with `--allow-unauthenticated`, because the shared
secret *is* the authentication.

Mode A is fine to start with. Move to Mode B when you care about rotation.

## 3. Worker service account (both modes)

The worker writes job and cache documents to Firestore and reads the AI keys
from Secret Manager. Give it a dedicated SA rather than reusing the default
compute one, so its permissions are legible later.

```bash
PROJECT=forkast-da914
REGION=us-central1
WORKER_SA=recipe-import-worker@$PROJECT.iam.gserviceaccount.com

gcloud iam service-accounts create recipe-import-worker \
  --display-name "Forkast recipe import worker"

gcloud projects add-iam-policy-binding $PROJECT \
  --member "serviceAccount:$WORKER_SA" --role roles/datastore.user

gcloud projects add-iam-policy-binding $PROJECT \
  --member "serviceAccount:$WORKER_SA" --role roles/secretmanager.secretAccessor

gcloud projects add-iam-policy-binding $PROJECT \
  --member "serviceAccount:$WORKER_SA" --role roles/logging.logWriter
```

`datastore.user` is Firestore. It looks like a typo for a Firestore role; it
is not.

## 4. Deploy

```bash
SERVICE=recipe-import-worker
IMAGE=us-central1-docker.pkg.dev/$PROJECT/gcf-artifacts/recipe-import-worker:$(git rev-parse --short HEAD)
WORKER_TOKEN=*** rand -hex 32)     # Mode A only
WORKER_URL=https://$SERVICE-XXXXX.a.run.app   # read from the deploy output
```

**Mode A — shared secret**

```bash
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --service-account $WORKER_SA \
  --memory 2Gi --cpu 1 --timeout 1800 \
  --min-instances 0 --max-instances 3 --concurrency 1 \
  --allow-unauthenticated \
  --set-env-vars "GCLOUD_PROJECT=$PROJECT" \
  --set-env-vars "RECIPE_MEDIA_TOOLING_AVAILABLE=true" \
  --set-env-vars "RECIPE_IMPORT_WORKER_TOKEN=$WORKER_TOKEN" \
  --set-env-vars "RECIPE_IMPORT_MAX_CONCURRENT_JOBS=1" \
  --set-env-vars "MEDIA_MAX_CONCURRENT_PER_PLATFORM=1" \
  --set-env-vars "MEDIA_MAX_CONCURRENT_TOTAL=1" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest"
```

**Mode B — OIDC**

```bash
INVOKER_SA=recipe-import-invoker@$PROJECT.iam.gserviceaccount.com
FUNCTION_SA=$PROJECT@appspot.gserviceaccount.com   # 1st Gen default

gcloud iam service-accounts create recipe-import-invoker \
  --display-name "Forkast recipe import invoker"

# The worker only accepts this identity.
gcloud run services add-iam-policy-binding $SERVICE --region $REGION \
  --member "serviceAccount:$INVOKER_SA" --role roles/run.invoker

# The function is allowed to MINT a token as that identity.
gcloud iam service-accounts add-iam-policy-binding $INVOKER_SA \
  --member "serviceAccount:$FUNCTION_SA" --role roles/iam.serviceAccountTokenCreator

gcloud run deploy $SERVICE \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --service-account $WORKER_SA \
  --memory 2Gi --cpu 1 --timeout 1800 \
  --min-instances 0 --max-instances 3 --concurrency 1 \
  --no-allow-unauthenticated \
  --set-env-vars "GCLOUD_PROJECT=$PROJECT" \
  --set-env-vars "RECIPE_MEDIA_TOOLING_AVAILABLE=true" \
  --set-env-vars "RECIPE_IMPORT_WORKER_AUDIENCE=$WORKER_URL" \
  --set-env-vars "RECIPE_IMPORT_MAX_CONCURRENT_JOBS=1" \
  --set-env-vars "MEDIA_MAX_CONCURRENT_PER_PLATFORM=1" \
  --set-env-vars "MEDIA_MAX_CONCURRENT_TOTAL=1" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest"
```

Do **not** set `RECIPE_IMPORT_WORKER_TOKEN` in Mode B. The dispatcher
prefers the shared secret when both are present, and would send a header the
private service never receives.

**Why these settings**

| Setting | Reason |
|---|---|
| `--concurrency 1` | ffmpeg and yt-dlp are CPU and disk bound. Two jobs per container means both get slower and both are more likely to fail. |
| `--memory 2Gi` | A capped frame set plus the Node heap. 1Gi is tight once base64 frames are in memory. |
| `--timeout 1800` | Cloud Run allows 60 min. A long download plus a long model call needs the room. |
| `--max-instances 3` | Bounds the blast radius and the bill. This is an escalation path, not the default route. |
| `--min-instances 0` | Cold start is ~10s. Acceptable for a path that already takes minutes. |

## 4b. Caveats on Mode B worth knowing

- The worker's own OIDC branch only checks that an `Authorization` header
  *exists*. It trusts Cloud Run to have verified it. That is only safe with
  `--no-allow-unauthenticated`. Never pair `RECIPE_IMPORT_WORKER_AUDIENCE`
  with a public service.
- `google-auth-library` is used by the OIDC path but is **not declared** in
  `functions/package.json` — it only resolves today because `firebase-admin`
  pulls it in. Declare it before relying on Mode B, or the path breaks
  silently the next time a transitive dependency moves.
- The `appspot` SA must hold `serviceAccountTokenCreator` on the invoker SA.
  Missing that is the most common Mode B failure, and it surfaces as an
  `x-recipe-import-oidc-error` header rather than a clean message.

## 5. Point Firebase at it

Add to `functions/.env` and redeploy functions:

```bash
# Mode A
RECIPE_IMPORT_WORKER_URL=https://$SERVICE-XXXXX.a.run.app
RECIPE_IMPORT_WORKER_TOKEN=<the same $WORKER_TOKEN>

# Mode B — instead of the token
RECIPE_IMPORT_WORKER_URL=https://$SERVICE-XXXXX.a.run.app
RECIPE_IMPORT_WORKER_SERVICE_ACCOUNT=recipe-import-invoker@forkast-da914.iam.gserviceaccount.com
```

```bash
cd ../.. && npx firebase deploy --only functions --project $PROJECT --force
```

## 5. Rollout order

1. Deploy the container. Confirm `/healthz` returns 200 and reports both
   `ytDlp` and `ffmpeg` versions.
2. Leave `RECIPE_IMPORT_WORKER_URL` unset. The Firestore trigger still does
   everything, so nothing changes yet.
3. Set `RECIPE_IMPORT_WORKER_URL`. Dispatch now goes to Cloud Run; the
   Firestore trigger still catches anything dispatch misses.
4. Once Cloud Run is proven, set `RECIPE_IMPORT_FIRESTORE_TRIGGER_ENABLED=false`
   to stop the duplicate path.

Step 4 is optional. Leaving the trigger on is a working safety net; the worker
claims jobs transactionally, so a job is never run twice.

---

## Environment variables this service reads

Everything is read from `functions/recipeImport/config.js`. The ones that
matter here:

**Tooling**
- `YT_DLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` — set in the Dockerfile
- `RECIPE_MEDIA_TOOLING_AVAILABLE` — `true` in this image

**Cost ceilings**
- `MAX_VIDEO_DURATION_SECONDS` (default 900)
- `MAX_VIDEO_BYTES` (default 209715200)
- `MAX_VIDEO_DOWNLOAD_SECONDS` (default 180)
- `FRAME_INTERVAL_SECONDS` (2), `MAX_FRAMES` (60), `FRAME_WIDTH` (640)

**YouTube direct path**
- `GEMINI_DIRECT_YOUTUBE_ENABLED` (default `true`)
- `GEMINI_DIRECT_YOUTUBE_MODEL` (default `gemini-3.5-flash-lite`)
- `GEMINI_VIDEO_MEDIA_RESOLUTION` (default `high`)
- `GEMINI_VIDEO_PROCESSING_MODE` (default `auto`)
- `GEMINI_VIDEO_AGENTIC_MIN_SECONDS` (default 120)

**Retry / concurrency**
- `MEDIA_RETRY_MAX_ATTEMPTS` (3), `MEDIA_RETRY_BASE_MS` (15000),
  `MEDIA_RETRY_MAX_MS` (180000), `MEDIA_RETRY_JITTER_RATIO` (0.25)
- `MEDIA_MAX_CONCURRENT_PER_PLATFORM` (1), `MEDIA_MAX_CONCURRENT_TOTAL` (2)

**Cache**
- `RECIPE_EVIDENCE_CACHE_ENABLED` (true)
- `RECIPE_EVIDENCE_CACHE_TTL_MINUTES` (360)
- `RECIPE_EVIDENCE_CACHE_COLLECTION` (`recipe_import_cache`)
- `RECIPE_EVIDENCE_CACHE_DEDUPE_WAIT_MS` (60000)

**Auth**
- `RECIPE_IMPORT_WORKER_TOKEN` — shared secret, if not using OIDC
- `RECIPE_IMPORT_WORKER_AUDIENCE` — set when Cloud Run IAM is doing the check

## 6. Checking it in production

```bash
# Versions actually running
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://recipe-import-worker-XXXXX.a.run.app/version

# Cloud Run logs for the startup line
gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="worker_startup"' \
  --limit 5 --project $PROJECT

# Count tooling misconfiguration alarms (should be zero)
gcloud logging read 'jsonPayload.event="media_tooling_disabled"' \
  --limit 50 --project $PROJECT
```

## 7. Temp files

Downloads, extracted audio and frames all go under `RECIPE_IMPORT_TEMP_DIR`
(`/tmp/forkcast-recipe-import`), in a per-job subdirectory that is removed in
a `finally` block whether the job succeeded, failed, or threw. On Cloud Run
`/tmp` is a RAM-backed disk that counts against the instance memory limit —
which is why `MAX_VIDEO_BYTES` and `MAX_FRAMES` are load-bearing rather than
cosmetic.
