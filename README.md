# forkcast-backend

Backend for Forkcast project - API for video transcription using yt-dlp.

## Features

- FastAPI-based REST API
- Video transcription using yt-dlp
- Automatic subtitle extraction (supports manual and auto-generated subtitles)
- CORS enabled for frontend integration

## API Endpoints

### `POST /transcribe`
Get transcription of a video from a URL.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "title": "Video Title",
  "transcription": "Full transcription text...",
  "success": true
}
```

### `GET /health`
Health check endpoint.

### `GET /`
API information and available endpoints.

## Local Development

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Run the server:
```bash
uvicorn main:app --reload
```

3. Access the API:
- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs
- Alternative docs: http://localhost:8000/redoc

## Deployment on Railway

1. Push your code to a Git repository (GitHub, GitLab, etc.)

2. Go to [Railway](https://railway.com/new) and create a new project

3. Connect your repository

4. Railway will automatically detect the Python project and deploy it

5. The API will be available at your Railway-provided URL

### Railway Configuration

The project includes:
- `Procfile`: Defines the web process
- `railway.json`: Railway-specific configuration
- `requirements.txt`: Python dependencies

Railway will automatically:
- Install Python dependencies
- Run the FastAPI server on the provided PORT

## Usage Example

```bash
curl -X POST "https://your-railway-url.railway.app/transcribe" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=VIDEO_ID"}'
```
