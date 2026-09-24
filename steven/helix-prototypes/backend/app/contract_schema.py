import json
from collections.abc import Mapping
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.jsonschema import DRAFT202012


def draft202012_validator(schema: Mapping[str, object], contracts: Path) -> Draft202012Validator:
    registry = Registry()
    for path in sorted(contracts.glob("*.schema.json")):
        contents = json.loads(path.read_text())
        resource = DRAFT202012.create_resource(contents)
        registry = registry.with_resource(contents["$id"], resource)
        registry = registry.with_resource(path.name, resource)
    return Draft202012Validator(schema, registry=registry)
