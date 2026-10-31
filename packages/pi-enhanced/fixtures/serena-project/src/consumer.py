from catalog import SymbolTarget


def consume_target() -> str:
    target = SymbolTarget()
    return target.label()

