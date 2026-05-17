from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional


class RoomStatus(str, Enum):
    MATCHED_WAITING = "MATCHED_WAITING_FOR_CONNECTIONS"
    ACTIVE = "ACTIVE"
    TIMEBOMB = "TIMEBOMB"
    DESTROYED = "DESTROYED"


@dataclass
class QueueEntry:
    user_id: str
    device_token: str
    location: str
    joined_at: datetime = field(default_factory=datetime.utcnow)
    ws: Optional[Any] = None  # WebSocket | None (None = 백그라운드)


@dataclass
class RoomUser:
    user_id: str
    device_token: str
    ws: Optional[Any] = None
    connected: bool = False
    disconnected_at: Optional[datetime] = None


@dataclass
class Room:
    room_id: str
    location: str
    users: Dict[str, RoomUser]
    status: RoomStatus = RoomStatus.MATCHED_WAITING
    matched_at: datetime = field(default_factory=datetime.utcnow)
    activated_at: Optional[datetime] = None
    timebomb_started_at: Optional[datetime] = None  # 폭탄 시작 시각
    connection_timeout_task: Optional[Any] = None   # asyncio.Task
    timebomb_task: Optional[Any] = None             # asyncio.Task
    reconnect_tasks: Dict[str, Any] = field(default_factory=dict)  # user_id -> asyncio.Task
