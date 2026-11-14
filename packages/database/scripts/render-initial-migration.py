#!/usr/bin/env python3
"""Offline renderer for this repository's deliberately bounded Prisma schema.

The environment could not download Prisma during Phase 1. This standard-library
tool emits the initial PostgreSQL DDL from the schema, verifies every relation's
field names, and refuses unknown database attributes. It does not replace Prisma
migrate diff for later migrations; use the real CLI once dependencies are present.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# This renderer exists solely for the immutable initial migration. Later schema
# changes must use Prisma migrate diff and a new migration, never rewrite 0001.
SCHEMA = ROOT / "test/fixtures/phase1.schema.prisma"
OUTPUT = ROOT / "prisma/migrations/202611050001_initial/migration.sql"


def quote(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def fields(value: str) -> list[str]:
    result = [item.strip() for item in value.split(",")]
    if any(not re.fullmatch(r"[A-Za-z_]\w*", item) for item in result):
        raise ValueError(f"Unsupported field list {value!r}")
    return result


def name(*parts: str) -> str:
    # PostgreSQL's NAMEDATALEN is 64 including the trailing NUL byte.
    result = "_".join(parts)
    if len(result.encode()) > 63:
        raise ValueError(f"Identifier too long: {result}")
    return result


def main() -> None:
    source = SCHEMA.read_text()
    enums: dict[str, list[str]] = {}
    for match in re.finditer(r"^enum\s+(\w+)\s*\{(.*?)^\}", source, re.M | re.S):
        values = [line.strip() for line in match[2].splitlines() if line.strip()]
        if not all(re.fullmatch(r"\w+", item) for item in values):
            raise ValueError(f"Unsupported enum attributes in {match[1]}")
        enums[match[1]] = values

    models: dict[str, dict] = {}
    for match in re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", source, re.M | re.S):
        model_name, body = match[1], match[2]
        table_map = re.search(r'@@map\("([^"]+)"\)', body)
        model = {"table": table_map[1] if table_map else model_name, "fields": {}, "attributes": [], "relations": []}
        for raw in body.splitlines():
            line = raw.strip()
            if not line or line.startswith("//"):
                continue
            if line.startswith("@@"):
                model["attributes"].append(line)
                continue
            field = re.fullmatch(r"(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)", line)
            if not field:
                raise ValueError(f"Cannot parse {model_name}: {line}")
            key, type_name, suffix, attrs = field.groups()
            col_map = re.search(r'@map\("([^"]+)"\)', attrs)
            model["fields"][key] = {"name": col_map[1] if col_map else key, "type": type_name, "suffix": suffix or "", "attrs": attrs}
        models[model_name] = model

    def columns(model: dict, keys: list[str]) -> str:
        for key in keys:
            if key not in model["fields"] or model["fields"][key]["type"] in models:
                raise ValueError(f"Unknown scalar column {model['table']}.{key}")
        return ", ".join(quote(model["fields"][key]["name"]) for key in keys)

    scalar_types = {"String": "TEXT", "Int": "INTEGER", "BigInt": "BIGINT", "Boolean": "BOOLEAN", "DateTime": "TIMESTAMP(3)", "Json": "JSONB", "Decimal": "DECIMAL(65,30)", "Float": "DOUBLE PRECISION", "Bytes": "BYTEA"}
    native_types = {"Uuid": "UUID", "VarChar": "VARCHAR", "Char": "CHAR", "SmallInt": "SMALLINT", "Integer": "INTEGER", "BigInt": "BIGINT", "Decimal": "DECIMAL", "Timestamptz": "TIMESTAMPTZ", "Timestamp": "TIMESTAMP", "Text": "TEXT", "JsonB": "JSONB"}
    statements = [
        "-- LiveStar Phase 1 initial schema.",
        "-- Rendered offline from schema.prisma by scripts/render-initial-migration.py.",
        "-- Prisma CLI / PostgreSQL verification must be run when tooling is available.",
        "-- Migration 0002 is required for accounting checks, immutability and grants.",
        "",
    ]
    for enum, values in enums.items():
        statements.append(f"CREATE TYPE {quote(enum)} AS ENUM ({', '.join(literal(item) for item in values)});\n")

    indexes: list[str] = []
    foreign_keys: list[str] = []
    scalar_count = 0
    for model_name, model in models.items():
        table = model["table"]
        declarations: list[str] = []
        primary: list[str] = []
        for key, field in model["fields"].items():
            type_name, suffix, attrs = field["type"], field["suffix"], field["attrs"]
            if type_name in models:
                relation = re.search(r"@relation\((.*)\)", attrs)
                if not relation:
                    continue  # Inverse relation; no local FK.
                local = re.search(r"fields:\s*\[([^]]+)\]", relation[1])
                target = re.search(r"references:\s*\[([^]]+)\]", relation[1])
                if local is None and target is None:
                    continue  # Named inverse relation.
                if local is None or target is None:
                    raise ValueError(f"Incomplete relation {model_name}.{key}")
                local_keys, target_keys = fields(local[1]), fields(target[1])
                target_model = models[type_name]
                if len(local_keys) != len(target_keys):
                    raise ValueError(f"Mismatched FK field count {model_name}.{key}")
                for a, b in zip(local_keys, target_keys):
                    if model["fields"][a]["type"] != target_model["fields"][b]["type"]:
                        raise ValueError(f"Mismatched FK types {model_name}.{key}")
                deletion = re.search(r"onDelete:\s*(\w+)", relation[1])
                on_delete = deletion[1] if deletion else ("SetNull" if suffix == "?" else "Restrict")
                actions = {"Restrict": "RESTRICT", "Cascade": "CASCADE", "SetNull": "SET NULL", "NoAction": "NO ACTION", "SetDefault": "SET DEFAULT"}
                constraint = name(table, *(model["fields"][item]["name"] for item in local_keys), "fkey")
                foreign_keys.append(f"ALTER TABLE {quote(table)} ADD CONSTRAINT {quote(constraint)} FOREIGN KEY ({columns(model, local_keys)}) REFERENCES {quote(target_model['table'])} ({columns(target_model, target_keys)}) ON DELETE {actions[on_delete]} ON UPDATE CASCADE;")
                continue
            scalar_count += 1
            sql_type = quote(type_name) if type_name in enums else scalar_types.get(type_name)
            if sql_type is None:
                raise ValueError(f"Unknown scalar {model_name}.{key}: {type_name}")
            native = re.search(r"@db\.(\w+)(?:\(([^)]+)\))?", attrs)
            if native:
                if native[1] not in native_types:
                    raise ValueError(f"Unsupported native type {native[1]}")
                sql_type = native_types[native[1]]
                if native[2]:
                    if not re.fullmatch(r"[\d, ]+", native[2]):
                        raise ValueError(f"Unsupported native parameters {native[2]}")
                    sql_type += f"({native[2]})"
            if suffix == "[]":
                sql_type += "[]"
            declaration = f"  {quote(field['name'])} {sql_type}"
            if suffix not in ("?", "[]"):
                declaration += " NOT NULL"
            default = re.search(r"@default\((uuid\(\)|now\(\)|[^()]*)\)", attrs)
            if default:
                value = default[1]
                if value == "uuid()":
                    pass  # Prisma client side UUID default, deliberately no SQL default.
                elif value == "now()":
                    declaration += " DEFAULT CURRENT_TIMESTAMP"
                elif value.startswith('"'):
                    declaration += " DEFAULT " + literal(json.loads(value))
                elif value in ("true", "false") or re.fullmatch(r"-?\d+", value):
                    declaration += " DEFAULT " + value
                elif type_name in enums and value in enums[type_name]:
                    declaration += " DEFAULT " + literal(value)
                else:
                    raise ValueError(f"Unsupported default {model_name}.{key}: {value}")
            if re.search(r"@id(?:\s|$)", attrs):
                primary.append(key)
            if re.search(r"@unique(?:\s|$)", attrs):
                indexes.append(f"CREATE UNIQUE INDEX {quote(name(table, field['name'], 'key'))} ON {quote(table)} ({quote(field['name'])});")
            declarations.append(declaration)
        for attr in model["attributes"]:
            if attr.startswith("@@map("):
                continue
            match = re.fullmatch(r"@@(id|index|unique)\(\[([^]]+)\]\)", attr)
            if not match:
                raise ValueError(f"Unsupported model attribute {model_name}: {attr}")
            kind, keys = match[1], fields(match[2])
            if kind == "id":
                if primary:
                    raise ValueError(f"Multiple primary keys {model_name}")
                primary = keys
            else:
                index_name = name(table, *(model["fields"][item]["name"] for item in keys), "key" if kind == "unique" else "idx")
                indexes.append(f"CREATE {'UNIQUE ' if kind == 'unique' else ''}INDEX {quote(index_name)} ON {quote(table)} ({columns(model, keys)});")
        if not primary:
            raise ValueError(f"No primary key {model_name}")
        declarations.append(f"  CONSTRAINT {quote(name(table, 'pkey'))} PRIMARY KEY ({columns(model, primary)})")
        statements.append(f"CREATE TABLE {quote(table)} (\n" + ",\n".join(declarations) + "\n);\n")

    statements.append("\n-- Unique constraints and query indexes.\n")
    statements.extend(indexes)
    statements.append("\n-- Foreign keys (created after all tables to allow cyclic relations).\n")
    statements.extend(foreign_keys)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(statements) + "\n")
    (ROOT / "prisma/migrations/migration_lock.toml").write_text('provider = "postgresql"\n')
    print(f"Rendered {len(enums)} enums, {len(models)} tables, {scalar_count} columns, {len(indexes)} indexes and {len(foreign_keys)} foreign keys.")
    print(OUTPUT)


if __name__ == "__main__":
    main()
