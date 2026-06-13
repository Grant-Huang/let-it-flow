"""Application configuration from environment."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[3]

# Project root .env (gitignored) is the canonical local dev secrets file.
# Vercel uses dashboard env vars with the same keys; load order allows cwd override.
load_dotenv(ROOT_DIR / ".env")
load_dotenv(ROOT_DIR / "backend" / ".env")
load_dotenv()
DATA_DIR = Path(os.getenv("LITPILOT_DATA_DIR", str(ROOT_DIR / "data"))).resolve()
