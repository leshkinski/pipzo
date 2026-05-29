from typing import Protocol

from pipzo_api.config import Settings
from pipzo_api.contract import AppSnapshot
from pipzo_api.mock_scenarios import MockScenarioStore

from .production import ProductionAdapters, ProductionAdapterNotImplemented


class AppStateAdapter(Protocol):
    def get_snapshot(self) -> AppSnapshot:
        raise NotImplementedError


class MockAppStateAdapter:
    def __init__(self, mock_store: MockScenarioStore) -> None:
        self._mock_store = mock_store

    def get_snapshot(self) -> AppSnapshot:
        return self._mock_store.get_snapshot()


class ProductionAppStateAdapter:
    def __init__(self, adapters: ProductionAdapters) -> None:
        self._adapters = adapters

    def get_snapshot(self) -> AppSnapshot:
        self._adapters.assert_implemented()
        raise ProductionAdapterNotImplemented("Production app state is not implemented")


def create_app_state_adapter(settings: Settings, mock_store: MockScenarioStore) -> AppStateAdapter:
    if settings.app_mode == "mock":
        return MockAppStateAdapter(mock_store)
    return ProductionAppStateAdapter(ProductionAdapters())
