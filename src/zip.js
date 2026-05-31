const ZIP_ENCODER = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  return { dosTime, dosDate };
}

function writer(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  return {
    bytes,
    u16(value) {
      view.setUint16(offset, value, true);
      offset += 2;
    },
    u32(value) {
      view.setUint32(offset, value >>> 0, true);
      offset += 4;
    },
    copy(value) {
      bytes.set(value, offset);
      offset += value.length;
    }
  };
}

export function createZip(files) {
  const parts = [];
  const centralParts = [];
  const { dosTime, dosDate } = dosDateTime();
  let localOffset = 0;
  const seenNames = new Set();

  for (const file of files) {
    if (!file?.name || seenNames.has(file.name)) continue;
    seenNames.add(file.name);
    const fileNameBytes = ZIP_ENCODER.encode(file.name);
    const dataBytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    const checksum = crc32(dataBytes);
    const flags = 0x0800;

    const local = writer(30 + fileNameBytes.length);
    local.u32(0x04034b50);
    local.u16(20);
    local.u16(flags);
    local.u16(0);
    local.u16(dosTime);
    local.u16(dosDate);
    local.u32(checksum);
    local.u32(dataBytes.length);
    local.u32(dataBytes.length);
    local.u16(fileNameBytes.length);
    local.u16(0);
    local.copy(fileNameBytes);

    parts.push(local.bytes, dataBytes);

    const central = writer(46 + fileNameBytes.length);
    central.u32(0x02014b50);
    central.u16(20);
    central.u16(20);
    central.u16(flags);
    central.u16(0);
    central.u16(dosTime);
    central.u16(dosDate);
    central.u32(checksum);
    central.u32(dataBytes.length);
    central.u32(dataBytes.length);
    central.u16(fileNameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(localOffset);
    central.copy(fileNameBytes);

    centralParts.push(central.bytes);
    localOffset += local.bytes.length + dataBytes.length;
  }

  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = writer(22);
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(files.length);
  end.u16(files.length);
  end.u32(centralSize);
  end.u32(centralOffset);
  end.u16(0);

  return new Uint8Array([...parts, ...centralParts, end.bytes].flatMap((part) => [...part]));
}

export function createLuaZip(appId, luaBytes) {
  return createZip([{ name: `${appId}.lua`, bytes: luaBytes }]);
}

export function createLuaManifestZip(appId, luaBytes, manifests = []) {
  const files = [{ name: `${appId}.lua`, bytes: luaBytes }];
  const seen = new Set(files.map((file) => file.name));

  for (const manifest of manifests) {
    const fileName = String(manifest?.fileName || "").trim();
    if (!fileName || !/\.manifest$/i.test(fileName)) continue;
    const zipName = fileName;
    if (seen.has(zipName)) continue;
    seen.add(zipName);
    files.push({ name: zipName, bytes: manifest.bytes });
  }

  return createZip(files);
}
