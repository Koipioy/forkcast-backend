from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
import yt_dlp
import json
import logging
import urllib.request
import re
import tempfile
import os
import sys
import time
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Track startup time for uptime calculation
start_time = time.time()

app = FastAPI(
    title="Forkcast Backend",
    description="API for video transcription using yt-dlp",
    version="1.0.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VideoRequest(BaseModel):
    url: HttpUrl


class TranscriptionResponse(BaseModel):
    url: str
    title: str
    transcription: str
    success: bool


class TranscriptionError(Exception):
    """Custom exception for transcription errors with HTTP status code"""
    def __init__(self, status_code: int, message: str, original_error: str = None):
        self.status_code = status_code
        self.message = message
        self.original_error = original_error
        super().__init__(self.message)


def classify_error(error: Exception) -> tuple[int, str]:
    """
    Classify yt-dlp errors and return appropriate HTTP status code and message
    """
    error_str = str(error).lower()
    original_error = str(error)
    
    # 403 Forbidden - Access denied (check this first as it's most specific)
    if '403' in error_str or 'forbidden' in error_str:
        return 403, "Access denied: The video source is blocking access to this content"
    
    # 404 Not Found - Video doesn't exist
    if '404' in error_str or 'not found' in error_str or 'does not exist' in error_str:
        return 404, "Video not found: The requested video could not be found"
    
    # 401 Unauthorized
    if '401' in error_str or 'unauthorized' in error_str:
        return 401, "Unauthorized: Authentication required to access this content"
    
    # Network/timeout errors
    if 'timeout' in error_str or 'connection' in error_str or 'network' in error_str:
        return 503, "Service unavailable: Network error while accessing the video source"
    
    # Unsupported URL/format or unable to download/extract
    if ('unsupported url' in error_str or 'no video formats found' in error_str or 
        'unable to extract' in error_str or 'unable to download' in error_str):
        return 400, f"Bad request: Unable to process this video URL"
    
    # No subtitles found
    if 'no english subtitles' in error_str or 'no subtitles' in error_str:
        return 400, "No subtitles available: This video does not have English subtitles"
    
    # Default to 500 for unexpected errors
    return 500, f"Internal server error: {original_error}"


def extract_transcription(url: str) -> dict:
    """
    Extract transcription from a video URL using yt-dlp
    """
    # Create a temporary directory for subtitle files
    with tempfile.TemporaryDirectory() as temp_dir:
        ydl_opts = {
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': ['en', 'en-US', 'en-GB'],
            'subtitlesformat': 'vtt',
            'skip_download': True,
            'outtmpl': os.path.join(temp_dir, '%(title)s.%(ext)s'),
            'quiet': True,
            'no_warnings': True,
        }
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Get video info and download subtitles
                info = ydl.extract_info(url, download=True)
                title = info.get('title', 'Unknown')
                
                # Look for downloaded subtitle files
                subtitle_files = []
                for file in os.listdir(temp_dir):
                    if file.endswith('.en.vtt') or file.endswith('.en-US.vtt') or file.endswith('.en-GB.vtt'):
                        subtitle_files.append(os.path.join(temp_dir, file))
                
                # If no files downloaded, try URL-based extraction
                if not subtitle_files:
                    subtitles = info.get('subtitles', {})
                    automatic_captions = info.get('automatic_captions', {})
                    all_subtitles = {**subtitles, **automatic_captions}
                    
                    for lang in ['en', 'en-US', 'en-GB']:
                        if lang in all_subtitles:
                            formats = all_subtitles[lang]
                            if formats:
                                # Prefer vtt format
                                preferred_format = None
                                for fmt in ['vtt', 'ttml', 'srv3', 'srv2', 'srv1']:
                                    if fmt in formats:
                                        preferred_format = fmt
                                        break
                                
                                if not preferred_format:
                                    preferred_format = list(formats.keys())[0]
                                
                                subtitle_url = formats[preferred_format]['url']
                                subtitle_content = urllib.request.urlopen(subtitle_url).read().decode('utf-8')
                                
                                if preferred_format == 'vtt':
                                    subtitle_data = parse_vtt(subtitle_content)
                                else:
                                    subtitle_data = subtitle_content
                                
                                return {
                                    'title': title,
                                    'transcription': subtitle_data,
                                    'success': True
                                }
                
                # Read from downloaded files
                if subtitle_files:
                    # Use the first available subtitle file
                    with open(subtitle_files[0], 'r', encoding='utf-8') as f:
                        subtitle_content = f.read()
                    
                    subtitle_data = parse_vtt(subtitle_content)
                    
                    return {
                        'title': title,
                        'transcription': subtitle_data,
                        'success': True
                    }
                
                raise Exception("No English subtitles found for this video")
                
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error extracting transcription: {error_msg}")
            # Re-raise with error classification info attached
            status_code, message = classify_error(e)
            logger.info(f"Classified error as {status_code}: {message}")
            raise TranscriptionError(status_code, message, error_msg)


def parse_vtt(vtt_content: str) -> str:
    """
    Parse VTT subtitle format and extract text
    """
    lines = vtt_content.split('\n')
    text_parts = []
    
    for line in lines:
        line = line.strip()
        # Skip VTT headers, timestamps, and empty lines
        if not line or line.startswith('WEBVTT') or '-->' in line or line.startswith('<'):
            continue
        # Skip cue identifiers (numbers)
        if line.isdigit():
            continue
        # Add actual text content
        if line:
            # Remove HTML tags if present
            line = re.sub(r'<[^>]+>', '', line)
            text_parts.append(line)
    
    return ' '.join(text_parts)


@app.get("/")
async def root():
    return {
        "message": "Forkcast Backend API",
        "endpoints": {
            "GET /": "This message",
            "POST /transcribe": "Get video transcription",
            "GET /health": "Health check",
            "GET /status": "Detailed status information"
        }
    }


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/status")
async def status():
    """
    Get detailed status information about the API service
    """
    try:
        # Calculate uptime
        uptime_seconds = int(time.time() - start_time)
        uptime_hours = uptime_seconds // 3600
        uptime_minutes = (uptime_seconds % 3600) // 60
        uptime_secs = uptime_seconds % 60
        
        # Check yt-dlp availability
        yt_dlp_status = "available"
        yt_dlp_version = "unknown"
        try:
            yt_dlp_version = yt_dlp.version.__version__
        except:
            try:
                import subprocess
                result = subprocess.run(['yt-dlp', '--version'], 
                                      capture_output=True, 
                                      text=True, 
                                      timeout=5)
                if result.returncode == 0:
                    yt_dlp_version = result.stdout.strip()
            except:
                yt_dlp_status = "unavailable"
        
        return {
            "status": "operational",
            "service": "Forkcast Backend API",
            "version": "1.0.0",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "uptime": {
                "seconds": uptime_seconds,
                "formatted": f"{uptime_hours}h {uptime_minutes}m {uptime_secs}s"
            },
            "dependencies": {
                "yt-dlp": {
                    "status": yt_dlp_status,
                    "version": yt_dlp_version
                },
                "python": {
                    "version": sys.version.split()[0]
                }
            },
            "endpoints": {
                "transcribe": "/transcribe",
                "health": "/health",
                "status": "/status"
            }
        }
    except Exception as e:
        logger.error(f"Error getting status: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_video(request: VideoRequest):
    """
    Transcribe a video from a URL using yt-dlp
    """
    try:
        url_str = str(request.url)
        logger.info(f"Processing transcription request for: {url_str}")
        
        result = extract_transcription(url_str)
        
        return TranscriptionResponse(
            url=url_str,
            title=result['title'],
            transcription=result['transcription'],
            success=True
        )
        
    except TranscriptionError as e:
        logger.error(f"Transcription failed ({e.status_code}): {e.message}")
        raise HTTPException(
            status_code=e.status_code,
            detail=e.message
        )
    except Exception as e:
        # Fallback for unexpected errors
        status_code, detail = classify_error(e)
        logger.error(f"Transcription failed ({status_code}): {detail}")
        raise HTTPException(
            status_code=status_code,
            detail=detail
        )

