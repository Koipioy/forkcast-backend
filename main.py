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

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
            logger.error(f"Error extracting transcription: {str(e)}")
            raise


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
            "GET /health": "Health check"
        }
    }


@app.get("/health")
async def health():
    return {"status": "healthy"}


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
        
    except Exception as e:
        logger.error(f"Transcription failed: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract transcription: {str(e)}"
        )

