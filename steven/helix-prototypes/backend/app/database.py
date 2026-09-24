from sqlite3 import Connection as SQLiteConnection

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import Settings
from .models import Base


def create_database_engine(settings: Settings) -> Engine:
    options: dict[str, object] = {"pool_pre_ping": True}
    sqlite = settings.database_url.startswith("sqlite")
    memory = sqlite and settings.database_url.endswith(":memory:")
    if sqlite:
        options["connect_args"] = {"check_same_thread": False, "timeout": 30.0}
        if memory:
            options["poolclass"] = StaticPool
    engine = create_engine(settings.database_url, **options)
    if sqlite and not memory:
        _serialize_sqlite_writers(engine)
    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def create_schema(engine: Engine) -> None:
    Base.metadata.create_all(engine)


def _serialize_sqlite_writers(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection: SQLiteConnection, _connection_record: object) -> None:
        dbapi_connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin(connection: Connection) -> None:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
