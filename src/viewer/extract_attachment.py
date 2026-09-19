#!/usr/bin/env python3
"""Extract readable content from OOXML attachments using only the stdlib."""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_R = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def docx_text(path: Path):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter(f"{W}p"):
        pieces = []
        for node in paragraph.iter():
            if node.tag == f"{W}t" and node.text:
                pieces.append(node.text)
            elif node.tag == f"{W}tab":
                pieces.append("\t")
        text = "".join(pieces).strip()
        if text:
            paragraphs.append(text)
    return {"kind": "text", "format": "DOCX", "content": "\n".join(paragraphs)}


def column_number(cell_reference: str):
    letters = re.match(r"[A-Z]+", cell_reference or "")
    if not letters:
        return 0
    number = 0
    for character in letters.group(0):
        number = number * 26 + ord(character) - 64
    return number - 1


def xlsx_content(path: Path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall(f"{S}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{S}t")))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            relationship.attrib["Id"]: relationship.attrib["Target"]
            for relationship in relationships.findall(f"{PKG_R}Relationship")
        }

        sheets = []
        for sheet in workbook.find(f"{S}sheets"):
            name = sheet.attrib.get("name", "Sheet")
            target = targets[sheet.attrib[f"{R}id"]].replace("\\", "/")
            sheet_path = target.lstrip("/")
            if not sheet_path.startswith("xl/"):
                sheet_path = f"xl/{sheet_path}"
            root = ET.fromstring(archive.read(sheet_path))
            rows = []
            sheet_data = root.find(f"{S}sheetData")
            if sheet_data is not None:
                for row in sheet_data.findall(f"{S}row"):
                    values = []
                    for cell in row.findall(f"{S}c"):
                        index = column_number(cell.attrib.get("r", ""))
                        while len(values) <= index:
                            values.append("")
                        cell_type = cell.attrib.get("t")
                        value_node = cell.find(f"{S}v")
                        if cell_type == "inlineStr":
                            inline = cell.find(f"{S}is")
                            value = "" if inline is None else "".join(
                                node.text or "" for node in inline.iter(f"{S}t")
                            )
                        elif value_node is None or value_node.text is None:
                            value = ""
                        elif cell_type == "s":
                            value = shared[int(value_node.text)]
                        elif cell_type == "b":
                            value = "TRUE" if value_node.text == "1" else "FALSE"
                        else:
                            value = value_node.text
                        values[index] = value
                    while values and values[-1] == "":
                        values.pop()
                    if values:
                        rows.append(values)
            sheets.append({"name": name, "rows": rows})
    return {"kind": "workbook", "format": "XLSX", "sheets": sheets}


def main():
    path = Path(sys.argv[1])
    try:
        if path.suffix.lower() == ".docx":
            result = docx_text(path)
        elif path.suffix.lower() == ".xlsx":
            result = xlsx_content(path)
        else:
            result = {"kind": "unavailable", "message": "Unsupported format"}
    except Exception as error:
        result = {
            "kind": "unavailable",
            "format": path.suffix.lstrip(".").upper(),
            "message": f"Preview could not be generated: {error}",
        }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
