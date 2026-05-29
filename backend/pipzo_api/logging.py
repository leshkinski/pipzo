import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any, Dict

from .config import Settings


LOGGER_NAME = "pipzo"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }

        event = getattr(record, "event", None)
        if event is not None:
            payload["event"] = event

        details = getattr(record, "details", None)
        if isinstance(details, dict):
            payload.update(details)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, sort_keys=True)


def configure_logging(settings: Settings) -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    level = getattr(logging, settings.log_level.upper())
    logger.setLevel(level)
    logger.propagate = False

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.setLevel(level)

    logger.handlers = [handler]
    return logger


def get_logger() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)
