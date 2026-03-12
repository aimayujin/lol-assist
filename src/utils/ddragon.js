// Riot Data Dragon utilities
const DDRAGON_BASE = 'https://ddragon.leagueoflegends.com';
let _version = null;

export async function getDDragonVersion() {
  if (_version) return _version;
  try {
    const res = await fetch(`${DDRAGON_BASE}/api/versions.json`);
    const versions = await res.json();
    _version = versions[0];
  } catch {
    _version = '14.24.1'; // fallback
  }
  return _version;
}

export async function getAllChampions() {
  const version = await getDDragonVersion();
  const res = await fetch(
    `${DDRAGON_BASE}/cdn/${version}/data/ja_JP/champion.json`
  );
  const data = await res.json();
  return data.data; // { [key]: { id, name, title, ... } }
}

export function championIconUrl(version, championId) {
  return `${DDRAGON_BASE}/cdn/${version}/img/champion/${championId}.png`;
}
