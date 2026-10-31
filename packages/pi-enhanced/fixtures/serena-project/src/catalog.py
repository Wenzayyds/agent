class SymbolTarget:
    """A stable symbol used by the Serena Docker compatibility test."""

    def label(self) -> str:
        return "serena-p1"


def build_target() -> SymbolTarget:
    return SymbolTarget()

