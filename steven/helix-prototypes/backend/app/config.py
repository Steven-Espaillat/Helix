from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_prefix="helix_", extra="ignore")

    database_url: str = "sqlite+pysqlite:///./helix.db"
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000"]
    )
    auto_seed: bool = True
    seed_path: Path = Path("../synthetic-e2e/helix-synthetic-bundle.json")
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str | None = None
    llm_model: str = "gpt-5-mini"
    codex_repository_root: Path = Path(__file__).resolve().parents[2]
    run_event_retention: int = Field(default=1000, ge=1)
    run_event_stream_seconds: float = Field(default=15.0, ge=0)
    run_event_poll_seconds: float = Field(default=1.0, gt=0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
