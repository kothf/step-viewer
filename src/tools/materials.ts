// Material library (FR-MAT-001): engineering materials by category with their usual properties.
// Pure data and lookups (no DOM), so the kernel workers, unit tests and the UI share it.
//
// Units: density g/cm³, E GPa, strengths MPa, k W/(m·K), cp J/(kg·K), alpha 10⁻⁶/K. A property that
// the cited source does not give (or that depends on heat treatment) is null and shown as "—".
// Strengths are the standard's minimum where the source is a product standard (`min`), otherwise
// typical handbook or data sheet values (`typ`): good for mass and first estimates, not a certificate.

export type MatCat = "steel" | "stainless" | "castiron" | "aluminium" | "copper" | "titanium" | "nickel" | "metal"
  | "plastic" | "elastomer" | "composite" | "ceramic" | "wood" | "other" | "custom";

export interface Material {
  name: string;
  /** g/cm³ */
  density: number;
  cat: MatCat;
  /** Other designations (EN number, AISI/UNS, GOST), also searched. */
  eq?: string;
  /** Young's modulus, GPa. */
  E?: number | null;
  /** Poisson's ratio. */
  nu?: number | null;
  /** Yield strength (Rp0.2), MPa. */
  sy?: number | null;
  /** Tensile strength, MPa. */
  su?: number | null;
  /** Thermal conductivity, W/(m·K). */
  k?: number | null;
  /** Specific heat, J/(kg·K). */
  cp?: number | null;
  /** Linear thermal expansion, 10⁻⁶/K. */
  alpha?: number | null;
  /** Appearance colour, #rrggbb. */
  color?: string;
  /** Key of `SOURCES`. */
  src?: string;
  /** Public page the density, modulus and strengths were checked against (no scheme), see `CHECKED`. */
  ref?: string;
}

/** What a document keeps: the name and density at least; the other properties travel with it. */
export type MatRef = Pick<Material, "name" | "density"> & Partial<Omit<Material, "name" | "density">>;

export const CATEGORIES: { id: MatCat; name: string; ru: string; color: string }[] = [
  { id: "steel", name: "Steels", ru: "Стали", color: "#8d9299" },
  { id: "stainless", name: "Stainless steels", ru: "Нержавеющие стали", color: "#c3c7cc" },
  { id: "castiron", name: "Cast irons and cast steel", ru: "Чугуны и литая сталь", color: "#5f6368" },
  { id: "aluminium", name: "Aluminium alloys", ru: "Алюминиевые сплавы", color: "#c9ced6" },
  { id: "copper", name: "Copper alloys", ru: "Медные сплавы", color: "#b87333" },
  { id: "titanium", name: "Titanium alloys", ru: "Титановые сплавы", color: "#9a9da3" },
  { id: "nickel", name: "Nickel alloys", ru: "Никелевые сплавы", color: "#a9a9a0" },
  { id: "metal", name: "Other metals", ru: "Другие металлы", color: "#b0b4ba" },
  { id: "plastic", name: "Plastics", ru: "Пластики", color: "#e8e6df" },
  { id: "elastomer", name: "Rubbers", ru: "Резины", color: "#2b2b2b" },
  { id: "composite", name: "Composites", ru: "Композиты", color: "#2f3338" },
  { id: "ceramic", name: "Glass and ceramics", ru: "Стекло и керамика", color: "#eceae4" },
  { id: "wood", name: "Woods and wood panels", ru: "Древесина и древесные плиты", color: "#b98d5a" },
  { id: "other", name: "Other materials", ru: "Другие материалы", color: "#9aa0a6" },
  { id: "custom", name: "My materials", ru: "Мои материалы", color: "#9aa0a6" },
];

/** Where the values come from; `min` = the standard's minimum strengths, `typ` = typical values. */
export const SOURCES: Record<string, { text: string; ru?: string; basis: "min" | "typ" }> = {
  en10025: { text: "EN 10025-2/-3/-6 (t ≤ 16 mm), EN 1993-1-1", basis: "min" },
  en10130: { text: "EN 10130, EN 10346", basis: "min" },
  en10083: { text: "EN 10083-2 (normalized, ≤ 16 mm), EN 10083-3 (quenched and tempered, 16–40 mm), EN 10277", ru: "EN 10083-2 (нормализация, ≤ 16 мм), EN 10083-3 (улучшение, 16–40 мм), EN 10277", basis: "min" },
  astm: { text: "ASTM A36 / A572 / A500", basis: "min" },
  asm1: { text: "ASM Handbook, Vol. 1", ru: "Справочник ASM Handbook, т. 1", basis: "typ" },
  gost: { text: "GOST 4543, GOST 14959, GOST 19281", ru: "ГОСТ 4543, ГОСТ 14959, ГОСТ 19281", basis: "min" },
  tool: { text: "Steel makers' data sheets (EN ISO 4957 grades)", ru: "Паспорта производителей стали (марки EN ISO 4957)", basis: "typ" },
  en10088: { text: "EN 10088-1, EN 10088-2 (hot rolled plate), EN 10088-3 (bar)", ru: "EN 10088-1, EN 10088-2 (горячекатаный лист), EN 10088-3 (пруток)", basis: "min" },
  en1561: { text: "EN 1561, EN 1563, EN 10293", basis: "min" },
  en485: { text: "EN 485-2, EN 755-2", basis: "min" },
  asm2: { text: "ASM Handbook, Vol. 2", ru: "Справочник ASM Handbook, т. 2", basis: "typ" },
  en1706: { text: "EN 1706", basis: "min" },
  nadca: { text: "NADCA Product Specification Standards for Die Castings", ru: "Стандарты NADCA на отливки под давлением", basis: "typ" },
  cda: { text: "Copper Development Association; EN 1652, EN 12163, EN 1982", ru: "Copper Development Association; EN 1652, EN 12163, EN 1982", basis: "typ" },
  astmTi: { text: "ASTM B348, ASM Handbook, Vol. 2", ru: "ASTM B348, справочник ASM Handbook, т. 2", basis: "min" },
  nickel: { text: "Producers' data sheets (Special Metals, Haynes, Carpenter); ASTM B164, B446, B637", ru: "Паспорта производителей (Special Metals, Haynes, Carpenter); ASTM B164, B446, B637", basis: "min" },
  crc: { text: "CRC Handbook of Chemistry and Physics; ASM Handbook, Vol. 2", ru: "Справочник CRC Handbook of Chemistry and Physics; ASM Handbook, т. 2", basis: "typ" },
  plastic: { text: "Producers' data sheets (ISO 527, dry as moulded)", ru: "Паспорта производителей (ISO 527, сухой материал)", basis: "typ" },
  rubber: { text: "Typical 70 Shore A compound; modulus from the hardness (Gent)", ru: "Типовая смесь 70 Shore A; модуль по твёрдости (Gent)", basis: "typ" },
  comp: { text: "Daniel, Ishai: Engineering Mechanics of Composite Materials (along the fibres)", ru: "Daniel, Ishai: Engineering Mechanics of Composite Materials (вдоль волокон)", basis: "typ" },
  iec: { text: "IEC 60893-3-2 (EP GC 202), IPC-4101", basis: "typ" },
  ceramic: { text: "Producers' data sheets (CoorsTek, Schott, Corning, Saint-Gobain); EN 572-1", ru: "Паспорта производителей (CoorsTek, Schott, Corning, Saint-Gobain); EN 572-1", basis: "typ" },
  wood: { text: "USDA Wood Handbook, FPL-GTR-282 (12 % moisture, along the grain)", ru: "USDA Wood Handbook, FPL-GTR-282 (влажность 12 %, вдоль волокон)", basis: "typ" },
  panel: { text: "EN 300, EN 312, EN 622-5, EN ISO 10456", basis: "min" },
  ec2: { text: "EN 1992-1-1, EN ISO 10456", basis: "typ" },
};

type P = number | null;
/** [density, E, nu, yield, tensile, k, cp, alpha] */
type Row = [MatCat, string, string, string, [number, P, P, P, P, P, P, P], string, string?];

const _ = null;
// prettier-ignore
const ROWS: Row[] = [
  // ---------- steels ----------
  ["steel", "Steel (carbon)", "Сталь (углеродистая)", "", [7.85, 210, 0.3, 235, 360, 54, 461, 12], "en10025"],
  ["steel", "Steel S235JR", "Сталь S235JR", "1.0038 · St37-2 · Ст3сп · ASTM A283 C", [7.85, 210, 0.3, 235, 360, 54, 461, 12], "en10025"],
  ["steel", "Steel S275JR", "Сталь S275JR", "1.0044 · St44-2 · Ст4сп", [7.85, 210, 0.3, 275, 410, 54, 461, 12], "en10025"],
  ["steel", "Steel S355J2", "Сталь S355J2", "1.0577 · St52-3 · 17Г1С", [7.85, 210, 0.3, 355, 470, 54, 461, 12], "en10025"],
  ["steel", "Steel S420N", "Сталь S420N", "1.8902", [7.85, 210, 0.3, 420, 520, _, _, 12], "en10025"],
  ["steel", "Steel S460N", "Сталь S460N", "1.8901", [7.85, 210, 0.3, 460, 540, _, _, 12], "en10025"],
  ["steel", "Steel S690QL", "Сталь S690QL", "1.8928", [7.85, 210, 0.3, 690, 770, _, _, 12], "en10025"],
  ["steel", "Steel S960QL", "Сталь S960QL", "1.8933", [7.85, 210, 0.3, 960, 980, _, _, 12], "en10025"],
  ["steel", "Steel ASTM A36", "Сталь ASTM A36", "UNS K02600", [7.85, 200, 0.26, 250, 400, 51.9, 486, 11.7], "astm"],
  ["steel", "Steel ASTM A572 Grade 50", "Сталь ASTM A572 Grade 50", "", [7.85, 200, 0.3, 345, 450, _, _, 11.7], "astm"],
  ["steel", "Steel ASTM A500 Grade B (shaped tube)", "Сталь ASTM A500 Grade B (профильная труба)", "", [7.85, 200, 0.3, 317, 400, _, _, 11.7], "astm"],
  ["steel", "Steel 09G2S", "Сталь 09Г2С", "09Г2С", [7.85, 200, 0.3, 345, 490, _, _, 11.4], "gost"],
  ["steel", "Steel DC01 (cold rolled sheet)", "Сталь DC01 (холоднокатаный лист)", "1.0330 · St12 · 08кп · SPCC", [7.85, 210, 0.3, 140, 270, _, _, 12], "en10130"],
  ["steel", "Steel DC04 (deep drawing sheet)", "Сталь DC04 (лист для глубокой вытяжки)", "1.0338 · St14 · 08Ю", [7.85, 210, 0.3, 140, 270, _, _, 12], "en10130"],
  ["steel", "Steel DX51D+Z (galvanized sheet)", "Сталь DX51D+Z (оцинкованный лист)", "1.0917", [7.85, 210, 0.3, _, 270, _, _, 12], "en10130"],
  ["steel", "Steel C22 (normalized)", "Сталь C22 (нормализованная)", "1.0402 · AISI 1020 · Сталь 20", [7.85, 210, 0.3, 240, 430, 51.9, 486, 11.7], "en10083"],
  ["steel", "Steel C35 (normalized)", "Сталь C35 (нормализованная)", "1.0501 · AISI 1035 · Сталь 35", [7.85, 210, 0.3, 300, 550, 50.8, 486, 11.3], "en10083"],
  ["steel", "Steel C45 (normalized)", "Сталь C45 (нормализованная)", "1.0503 · AISI 1045 · Сталь 45", [7.85, 210, 0.3, 340, 620, 49.8, 486, 11.5], "en10083"],
  ["steel", "Steel C60 (normalized)", "Сталь C60 (нормализованная)", "1.0601 · AISI 1060 · Сталь 60", [7.85, 210, 0.3, 380, 710, 49.8, 486, 11.1], "en10083"],
  ["steel", "Steel AISI 1018 (cold drawn)", "Сталь AISI 1018 (холоднотянутая)", "UNS G10180", [7.87, 205, 0.29, 370, 440, 51.9, 486, 11.5], "asm1"],
  ["steel", "Steel 11SMn30 (free cutting, cold drawn)", "Сталь 11SMn30 (автоматная, холоднотянутая)", "1.0715 · AISI 1215 · А12", [7.85, 210, 0.3, 375, 460, _, _, 12], "en10083"],
  ["steel", "Steel 25CrMo4 (quenched and tempered)", "Сталь 25CrMo4 (улучшенная)", "1.7218 · AISI 4130 · 30ХМ", [7.85, 210, 0.3, 600, 800, 42.7, 477, 12.2], "en10083"],
  ["steel", "Steel 41Cr4 (quenched and tempered)", "Сталь 41Cr4 (улучшенная)", "1.7035 · AISI 5140 · 40Х", [7.85, 210, 0.3, 660, 900, 44.8, 473, 12.3], "en10083"],
  ["steel", "Steel 42CrMo4 (quenched and tempered)", "Сталь 42CrMo4 (улучшенная)", "1.7225 · AISI 4140 · 38ХМ", [7.85, 210, 0.3, 750, 1000, 42.6, 473, 12.2], "en10083"],
  ["steel", "Steel 34CrNiMo6 (quenched and tempered)", "Сталь 34CrNiMo6 (улучшенная)", "1.6582 · AISI 4340 · 38Х2Н2МА", [7.85, 210, 0.3, 900, 1100, 44.5, 475, 12.3], "en10083"],
  ["steel", "Steel 51CrV4 (spring, quenched and tempered)", "Сталь 51CrV4 (пружинная, улучшенная)", "1.8159 · AISI 6150 · 50ХФА", [7.85, 210, 0.3, 800, 1000, 46.6, 475, 12.2], "en10083"],
  ["steel", "Steel 30KhGSA (quenched and tempered)", "Сталь 30ХГСА (улучшенная)", "30ХГСА", [7.85, 215, 0.3, 835, 1080, 38, 496, 11.7], "gost"],
  ["steel", "Steel 65G (spring, quenched and tempered)", "Сталь 65Г (пружинная, улучшенная)", "65Г · AISI 1066", [7.85, 215, 0.3, 785, 980, 37, 490, 11.8], "gost"],
  ["steel", "Steel 100Cr6 (bearing)", "Сталь 100Cr6 (подшипниковая)", "1.3505 · AISI 52100 · ШХ15", [7.81, 210, 0.3, _, _, 46.6, 475, 11.9], "asm1"],
  ["steel", "Tool steel X153CrMoV12", "Инструментальная сталь X153CrMoV12", "1.2379 · AISI D2 · Х12МФ", [7.7, 210, 0.3, _, _, 20, 460, 10.5], "tool"],
  ["steel", "Tool steel X40CrMoV5-1", "Инструментальная сталь X40CrMoV5-1", "1.2344 · AISI H13 · 4Х5МФ1С", [7.8, 210, 0.3, _, _, 24.3, 460, 10.4], "tool"],
  ["steel", "Tool steel 90MnCrV8", "Инструментальная сталь 90MnCrV8", "1.2842 · AISI O2 · 9Г2Ф", [7.85, 210, 0.3, _, _, 33, 460, 12.2], "tool"],
  ["steel", "High speed steel HS6-5-2", "Быстрорежущая сталь HS6-5-2", "1.3343 · AISI M2 · Р6М5", [8.12, 217, 0.3, _, _, 19, 460, 11.5], "tool"],

  // ---------- stainless steels ----------
  ["stainless", "Stainless steel 304", "Нержавеющая сталь 304", "AISI 304 · UNS S30400", [8.0, 193, 0.29, 215, 505, 16.2, 500, 17.3], "asm1"],
  ["stainless", "Stainless steel 1.4301 (X5CrNi18-10)", "Нержавеющая сталь 1.4301 (X5CrNi18-10)", "AISI 304 · 08Х18Н10 · A2", [7.9, 200, 0.3, 210, 520, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4307 (X2CrNi18-9)", "Нержавеющая сталь 1.4307 (X2CrNi18-9)", "AISI 304L · 03Х18Н11", [7.9, 200, 0.3, 200, 500, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4305 (X8CrNiS18-9)", "Нержавеющая сталь 1.4305 (X8CrNiS18-9)", "AISI 303 · A1", [7.9, 200, 0.3, 190, 500, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4310 (X10CrNi18-8)", "Нержавеющая сталь 1.4310 (X10CrNi18-8)", "AISI 301 · 12Х18Н9", [7.9, 200, 0.3, 250, 600, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4401 (X5CrNiMo17-12-2)", "Нержавеющая сталь 1.4401 (X5CrNiMo17-12-2)", "AISI 316 · A4", [8.0, 200, 0.3, 220, 520, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4404 (X2CrNiMo17-12-2)", "Нержавеющая сталь 1.4404 (X2CrNiMo17-12-2)", "AISI 316L · 03Х17Н14М3", [8.0, 200, 0.3, 220, 520, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4571 (X6CrNiMoTi17-12-2)", "Нержавеющая сталь 1.4571 (X6CrNiMoTi17-12-2)", "AISI 316Ti · 10Х17Н13М2Т", [8.0, 200, 0.3, 220, 520, 15, 500, 16.5], "en10088"],
  ["stainless", "Stainless steel 1.4541 (X6CrNiTi18-10)", "Нержавеющая сталь 1.4541 (X6CrNiTi18-10)", "AISI 321 · 08Х18Н10Т · 12Х18Н10Т", [7.9, 200, 0.3, 200, 500, 15, 500, 16], "en10088"],
  ["stainless", "Stainless steel 1.4539 (X1NiCrMoCu25-20-5)", "Нержавеющая сталь 1.4539 (X1NiCrMoCu25-20-5)", "904L · UNS N08904", [8.0, 195, 0.3, 220, 520, 12, 450, 15.8], "en10088"],
  ["stainless", "Stainless steel 1.4016 (X6Cr17, ferritic)", "Нержавеющая сталь 1.4016 (X6Cr17, ферритная)", "AISI 430 · 12Х17", [7.7, 220, 0.3, 240, 430, 25, 460, 10], "en10088"],
  ["stainless", "Stainless steel 1.4512 (X2CrTi12, ferritic)", "Нержавеющая сталь 1.4512 (X2CrTi12, ферритная)", "AISI 409", [7.7, 220, 0.3, 210, 380, 25, 460, 10.5], "en10088"],
  ["stainless", "Stainless steel 1.4021 (X20Cr13, QT700)", "Нержавеющая сталь 1.4021 (X20Cr13, QT700)", "AISI 420 · 20Х13", [7.7, 215, 0.3, 500, 700, 30, 460, 10.5], "en10088"],
  ["stainless", "Stainless steel 1.4057 (X17CrNi16-2, QT800)", "Нержавеющая сталь 1.4057 (X17CrNi16-2, QT800)", "AISI 431 · 14Х17Н2", [7.7, 215, 0.3, 600, 800, 25, 460, 10], "en10088"],
  ["stainless", "Stainless steel 1.4125 (X105CrMo17)", "Нержавеющая сталь 1.4125 (X105CrMo17)", "AISI 440C · 95Х18", [7.7, 215, 0.3, _, _, 15, 430, 10.4], "en10088"],
  ["stainless", "Stainless steel 1.4542 (17-4 PH, P1070)", "Нержавеющая сталь 1.4542 (17-4 PH, P1070)", "AISI 630 · UNS S17400 · X5CrNiCuNb16-4", [7.8, 200, 0.3, 1000, 1070, 16, 500, 10.9], "en10088"],
  ["stainless", "Stainless steel 1.4462 (duplex 2205)", "Нержавеющая сталь 1.4462 (дуплексная 2205)", "X2CrNiMoN22-5-3 · UNS S32205", [7.8, 200, 0.3, 460, 640, 15, 500, 13], "en10088"],
  ["stainless", "Stainless steel 1.4410 (super duplex 2507)", "Нержавеющая сталь 1.4410 (супердуплексная 2507)", "X2CrNiMoN25-7-4 · UNS S32750", [7.8, 200, 0.3, 530, 730, 15, 500, 13], "en10088"],

  // ---------- cast irons and cast steel ----------
  ["castiron", "Cast iron", "Чугун", "", [7.2, 110, 0.26, _, 250, 48.5, 460, 11.7], "en1561"],
  ["castiron", "Grey cast iron EN-GJL-150", "Серый чугун EN-GJL-150", "GG15 · СЧ15 · ASTM A48 Class 20", [7.1, 90, 0.26, _, 150, 52.5, 460, 11.7], "en1561"],
  ["castiron", "Grey cast iron EN-GJL-200", "Серый чугун EN-GJL-200", "GG20 · СЧ20 · ASTM A48 Class 30", [7.15, 100, 0.26, _, 200, 50, 460, 11.7], "en1561"],
  ["castiron", "Grey cast iron EN-GJL-250", "Серый чугун EN-GJL-250", "GG25 · СЧ25 · ASTM A48 Class 35", [7.2, 110, 0.26, _, 250, 48.5, 460, 11.7], "en1561"],
  ["castiron", "Grey cast iron EN-GJL-300", "Серый чугун EN-GJL-300", "GG30 · СЧ30 · ASTM A48 Class 45", [7.25, 123, 0.26, _, 300, 47.5, 460, 11.7], "en1561"],
  ["castiron", "Ductile cast iron EN-GJS-400-15", "Высокопрочный чугун EN-GJS-400-15", "GGG40 · ВЧ40 · ASTM A536 60-40-18", [7.1, 169, 0.275, 250, 400, 36.2, 515, 12.5], "en1561"],
  ["castiron", "Ductile cast iron EN-GJS-500-7", "Высокопрочный чугун EN-GJS-500-7", "GGG50 · ВЧ50 · ASTM A536 65-45-12", [7.1, 169, 0.275, 320, 500, 35.2, 515, 12.5], "en1561"],
  ["castiron", "Ductile cast iron EN-GJS-600-3", "Высокопрочный чугун EN-GJS-600-3", "GGG60 · ВЧ60 · ASTM A536 80-55-06", [7.2, 174, 0.275, 370, 600, 32.5, 515, 12.5], "en1561"],
  ["castiron", "Ductile cast iron EN-GJS-700-2", "Высокопрочный чугун EN-GJS-700-2", "GGG70 · ВЧ70 · ASTM A536 100-70-03", [7.2, 176, 0.275, 420, 700, 31.1, 515, 12.5], "en1561"],
  ["castiron", "Cast steel GE240", "Литая сталь GE240", "1.0446 · GS-45 · 25Л", [7.85, 210, 0.3, 240, 450, _, _, 12], "en1561", "#8d9299"],

  // ---------- aluminium alloys ----------
  ["aluminium", "Aluminium 6061", "Алюминий 6061", "EN AW-6061 T6 · AlMg1SiCu · АД33", [2.7, 68.9, 0.33, 276, 310, 167, 896, 23.6], "asm2"],
  ["aluminium", "Aluminium EN AW-1050A H14", "Алюминий EN AW-1050A H14", "Al99.5 · АД0", [2.7, 69, 0.33, 85, 105, 229, 900, 23.5], "en485"],
  ["aluminium", "Aluminium EN AW-2017A T4", "Алюминий EN AW-2017A T4", "AlCu4MgSi · Д1Т", [2.79, 72.5, 0.33, 260, 380, 134, 880, 23.6], "en485"],
  ["aluminium", "Aluminium EN AW-2024 T3", "Алюминий EN AW-2024 T3", "AlCu4Mg1 · Д16Т", [2.78, 73.1, 0.33, 345, 483, 121, 875, 23.2], "asm2"],
  ["aluminium", "Aluminium EN AW-3003 H14", "Алюминий EN AW-3003 H14", "AlMn1Cu · АМц", [2.73, 68.9, 0.33, 145, 152, 159, 893, 23.2], "asm2"],
  ["aluminium", "Aluminium EN AW-5052 H32", "Алюминий EN AW-5052 H32", "AlMg2.5 · АМг2,5", [2.68, 70.3, 0.33, 193, 228, 138, 880, 23.8], "asm2"],
  ["aluminium", "Aluminium EN AW-5083 O/H111", "Алюминий EN AW-5083 O/H111", "AlMg4.5Mn0.7 · АМг4,5", [2.66, 71, 0.33, 125, 275, 117, 900, 23.8], "en485"],
  ["aluminium", "Aluminium EN AW-5754 H22", "Алюминий EN AW-5754 H22", "AlMg3 · АМг3", [2.67, 70, 0.33, 130, 220, 132, 897, 23.7], "en485"],
  ["aluminium", "Aluminium EN AW-6060 T6", "Алюминий EN AW-6060 T6", "AlMgSi · АД31Т1", [2.7, 69, 0.33, 150, 190, 209, 898, 23.4], "en485"],
  ["aluminium", "Aluminium EN AW-6063 T6", "Алюминий EN AW-6063 T6", "AlMg0.7Si", [2.7, 68.9, 0.33, 170, 215, 200, 900, 23.4], "en485"],
  ["aluminium", "Aluminium EN AW-6082 T6", "Алюминий EN AW-6082 T6", "AlSi1MgMn · АД35Т1", [2.7, 70, 0.33, 260, 310, 172, 896, 23.4], "en485"],
  ["aluminium", "Aluminium EN AW-7020 T6", "Алюминий EN AW-7020 T6", "AlZn4.5Mg1 · 1915Т", [2.78, 70, 0.33, 290, 350, 137, 875, 23.1], "en485"],
  ["aluminium", "Aluminium EN AW-7075 T6", "Алюминий EN AW-7075 T6", "AlZn5.5MgCu · В95Т1", [2.81, 71.7, 0.33, 503, 572, 130, 960, 23.6], "asm2"],
  ["aluminium", "Cast aluminium EN AC-42100 T6 (AlSi7Mg0.3, sand cast)", "Литейный алюминий EN AC-42100 T6 (AlSi7Mg0.3, литьё в песок)", "A356 · АК7ч · АЛ9", [2.68, 72.4, 0.33, 190, 230, 151, 963, 21.4], "en1706"],
  ["aluminium", "Cast aluminium EN AC-43000 T6 (AlSi10Mg)", "Литейный алюминий EN AC-43000 T6 (AlSi10Mg)", "A360 · АК9ч · АЛ4", [2.65, 74, 0.33, 180, 220, _, _, 21], "en1706"],
  ["aluminium", "Die cast aluminium A380", "Алюминий A380 (литьё под давлением)", "EN AC-46000 · AlSi9Cu3(Fe) · АК8М3", [2.71, 71, 0.33, 159, 324, 96.2, 963, 21.8], "nadca"],

  // ---------- copper alloys ----------
  ["copper", "Copper", "Медь", "Cu-ETP · CW004A · C11000 · М1", [8.96, 117, 0.34, 69, 220, 391, 385, 17], "cda"],
  ["copper", "Brass", "Латунь", "", [8.5, 110, 0.34, _, 300, 120, 377, 20.2], "cda", "#c9a544"],
  ["copper", "Brass CuZn37", "Латунь CuZn37", "CW508L · C27400 · Л63", [8.44, 110, 0.34, _, 300, 120, 377, 20.2], "cda", "#c9a544"],
  ["copper", "Brass CuZn39Pb3 (free cutting)", "Латунь CuZn39Pb3 (автоматная)", "CW614N · C38500 · ЛС59-1", [8.47, 97, 0.34, _, 430, 123, 377, 20.9], "cda", "#c9a544"],
  ["copper", "Bronze CuSn8 (phosphor bronze)", "Бронза CuSn8 (оловянно-фосфористая)", "CW453K · C52100 · БрОФ7-0,2", [8.8, 115, 0.34, _, 390, 62, 377, 18.2], "cda", "#a9793d"],
  ["copper", "Cast bronze CuSn12-C", "Литейная бронза CuSn12-C", "CC483K · C90800 · БрО10Ф1", [8.7, 97, 0.34, 140, 260, 55, 376, 18.5], "cda", "#a9793d"],
  ["copper", "Gunmetal CuSn5Zn5Pb5-C", "Бронза CuSn5Zn5Pb5-C (литейная)", "CC491K · C83600 · БрО5Ц5С5", [8.7, 83, 0.34, 90, 200, 72, 376, 18], "cda", "#a9793d"],
  ["copper", "Aluminium bronze CuAl10Ni5Fe4", "Алюминиевая бронза CuAl10Ni5Fe4", "CW307G · C63000 · БрАЖН10-4-4", [7.58, 120, 0.33, _, 680, 39, 377, 16.2], "cda", "#b08d57"],
  ["copper", "Beryllium copper CuBe2 (age hardened)", "Бериллиевая бронза CuBe2 (состаренная)", "CW101C · C17200 · БрБ2", [8.25, 131, 0.3, 965, 1140, 105, 420, 16.7], "cda", "#b08d57"],

  // ---------- titanium ----------
  ["titanium", "Titanium Ti-6Al-4V", "Титан Ti-6Al-4V", "Grade 5 · 3.7165 · ВТ6", [4.43, 113.8, 0.342, 828, 895, 6.7, 526, 8.6], "astmTi"],
  ["titanium", "Titanium Ti-6Al-4V ELI", "Титан Ti-6Al-4V ELI", "Grade 23 · ВТ6С", [4.43, 113.8, 0.342, 759, 828, 6.7, 526, 8.6], "astmTi"],
  ["titanium", "Titanium Grade 1", "Титан Grade 1", "3.7025 · ВТ1-00", [4.51, 103, 0.37, 138, 240, 16, 520, 8.6], "astmTi"],
  ["titanium", "Titanium Grade 2", "Титан Grade 2", "3.7035 · ВТ1-0", [4.51, 103, 0.37, 275, 345, 16.4, 523, 8.6], "astmTi"],
  ["titanium", "Titanium Grade 4", "Титан Grade 4", "3.7065", [4.51, 105, 0.37, 483, 550, 17.2, 540, 8.6], "astmTi"],

  // ---------- nickel alloys ----------
  ["nickel", "Nickel 200", "Никель 200", "2.4066 · UNS N02200 · НП2", [8.89, 204, 0.29, 105, 380, 70.2, 456, 13.3], "nickel"],
  ["nickel", "Inconel 718 (aged)", "Inconel 718 (состаренный)", "2.4668 · UNS N07718 · ХН45МВТЮБР", [8.19, 200, 0.29, 1034, 1276, 11.4, 435, 13], "nickel"],
  ["nickel", "Inconel 625 (annealed)", "Inconel 625 (отожжённый)", "2.4856 · UNS N06625 · ХН75МБТЮ", [8.44, 208, 0.28, 414, 827, 9.8, 410, 12.8], "nickel"],
  ["nickel", "Monel 400 (annealed)", "Monel 400 (отожжённый)", "2.4360 · UNS N04400 · НМЖМц28-2,5-1,5", [8.8, 179, 0.32, 170, 480, 21.8, 427, 13.9], "nickel"],
  ["nickel", "Hastelloy C-276", "Hastelloy C-276", "2.4819 · UNS N10276 · ХН65МВ", [8.89, 205, 0.31, 283, 690, 9.8, 427, 11.2], "nickel"],
  ["nickel", "Invar 36", "Инвар 36", "1.3912 · UNS K93600 · 36Н", [8.05, 141, 0.26, 276, 448, 10.5, 515, 1.3], "nickel"],

  // ---------- other metals ----------
  ["metal", "Magnesium AZ31B H24", "Магний AZ31B H24", "3.5312 · МА2-1", [1.77, 45, 0.35, 220, 290, 96, 1000, 26], "asm2"],
  ["metal", "Die cast magnesium AZ91D", "Магний AZ91D (литьё под давлением)", "EN MC21120 · МЛ5", [1.81, 45, 0.35, 160, 230, 72, 1050, 26], "nadca"],
  ["metal", "Zinc alloy Zamak 3", "Цинковый сплав Zamak 3", "ZP3 · ZnAl4 · ЦА4", [6.6, 86, 0.3, 221, 283, 113, 419, 27.4], "nadca"],
  ["metal", "Zinc alloy Zamak 5", "Цинковый сплав Zamak 5", "ZP5 · ZnAl4Cu1 · ЦА4М1", [6.7, 86, 0.3, 269, 328, 109, 419, 27.4], "nadca"],
  ["metal", "Zinc", "Цинк", "Zn · Ц0", [7.14, 108, 0.25, _, _, 116, 388, 30.2], "crc"],
  ["metal", "Lead", "Свинец", "Pb · С1", [11.34, 16, 0.44, _, 12, 35.3, 129, 28.9], "crc", "#6f747b"],
  ["metal", "Tungsten", "Вольфрам", "W", [19.25, 411, 0.28, _, _, 173, 132, 4.5], "crc", "#7d8187"],
  ["metal", "Molybdenum", "Молибден", "Mo", [10.22, 329, 0.31, _, _, 138, 251, 4.8], "crc"],
  ["metal", "Silver", "Серебро", "Ag", [10.49, 83, 0.37, _, _, 429, 235, 18.9], "crc", "#d8d8d8"],
  ["metal", "Gold", "Золото", "Au", [19.32, 78, 0.44, _, _, 318, 129, 14.2], "crc", "#d4af37"],

  // ---------- plastics ----------
  ["plastic", "ABS", "ABS", "", [1.04, 2.3, 0.35, 43, 43, 0.17, 1300, 90], "plastic", "#e9e4d4"],
  ["plastic", "ASA", "ASA", "", [1.07, 2.3, _, 48, 48, 0.17, 1300, 95], "plastic", "#e9e4d4"],
  ["plastic", "PLA", "PLA", "", [1.24, 3.6, 0.36, 60, 60, 0.13, 1800, 68], "plastic", "#dfe3e6"],
  ["plastic", "PETG", "PETG", "", [1.27, 2.1, _, 50, 50, 0.21, 1300, 51], "plastic", "#dfe6ea"],
  ["plastic", "PET (PET-P)", "PET (ПЭТ)", "", [1.38, 3.2, _, 69, 69, 0.29, 1170, 70], "plastic", "#f1f1ee"],
  ["plastic", "Nylon PA6", "Нейлон PA6", "ПА6 · капролон", [1.14, 3.0, 0.39, 80, 80, 0.25, 1700, 80], "plastic", "#efece2"],
  ["plastic", "Nylon PA66", "Нейлон PA66", "ПА66", [1.14, 2.4, 0.39, 83, 83, 0.25, 1700, 80], "plastic", "#efece2"],
  ["plastic", "Nylon PA66-GF30", "Нейлон PA66-GF30", "ПА66-СВ30", [1.36, 10, 0.35, _, 190, 0.35, 1500, 25], "plastic", "#3a3d42"],
  ["plastic", "Nylon PA12", "Нейлон PA12", "ПА12", [1.01, 1.4, _, 45, 45, 0.23, _, 120], "plastic", "#efece2"],
  ["plastic", "Nylon PA12 (laser sintered)", "Нейлон PA12 (лазерное спекание)", "PA 2200 · SLS", [0.93, 1.65, _, _, 48, _, _, _], "plastic", "#f4f4f1"],
  ["plastic", "Polycarbonate", "Поликарбонат", "PC · ПК", [1.2, 2.4, 0.37, 65, 65, 0.2, 1200, 65], "plastic", "#dfe9ee"],
  ["plastic", "PC/ABS", "PC/ABS", "", [1.13, 2.2, _, 52, 52, 0.2, _, 80], "plastic", "#3a3d42"],
  ["plastic", "POM (Delrin)", "POM (Delrin, полиацеталь)", "POM-H", [1.41, 2.4, 0.35, 76, 76, 0.33, 1470, 120], "plastic", "#f4f4f1"],
  ["plastic", "POM-C (acetal copolymer)", "POM-C (полиацеталь, сополимер)", "ПОМ", [1.41, 2.8, 0.35, 64, 64, 0.31, 1470, 110], "plastic", "#f4f4f1"],
  ["plastic", "PEEK", "PEEK", "ПЭЭК", [1.32, 4.5, 0.4, 110, 110, 0.29, 2200, 45], "plastic", "#cdbf9f"],
  ["plastic", "PEI (Ultem 1000)", "PEI (Ultem 1000)", "ПЭИ", [1.27, 3.6, 0.36, 110, 110, 0.22, _, 56], "plastic", "#c79a3c"],
  ["plastic", "PMMA (acrylic)", "PMMA (оргстекло)", "ПММА", [1.19, 3.3, 0.37, _, 80, 0.19, 1470, 70], "plastic", "#e6eef2"],
  ["plastic", "PVC-U (rigid PVC)", "PVC-U (жёсткий ПВХ)", "ПВХ", [1.4, 3.0, 0.38, 55, 55, 0.16, 900, 80], "plastic", "#8a8e93"],
  ["plastic", "Polypropylene PP-H", "Полипропилен PP-H", "ПП", [0.91, 1.7, 0.42, 32, 32, 0.22, 1700, 160], "plastic", "#e8e6df"],
  ["plastic", "Polyethylene PE-HD", "Полиэтилен PE-HD", "HDPE · ПНД", [0.95, 1.1, 0.42, 23, 23, 0.38, 1900, 180], "plastic", "#ecebe6"],
  ["plastic", "Polyethylene PE-LD", "Полиэтилен PE-LD", "LDPE · ПВД", [0.92, 0.2, _, 10, 10, 0.33, _, 200], "plastic", "#ecebe6"],
  ["plastic", "Polyethylene PE-UHMW", "Полиэтилен PE-UHMW", "PE 1000 · СВМПЭ", [0.93, 0.7, _, 20, 20, 0.4, 1900, 200], "plastic", "#ecebe6"],
  ["plastic", "PTFE", "PTFE (фторопласт-4)", "Teflon · Ф-4", [2.16, 0.5, 0.46, _, 25, 0.25, 1000, 130], "plastic", "#f6f6f4"],
  ["plastic", "Polystyrene PS", "Полистирол PS", "GPPS · ПС", [1.05, 3.2, 0.34, _, 45, 0.16, 1300, 70], "plastic", "#e6eef2"],
  ["plastic", "Polystyrene HIPS", "Полистирол HIPS", "УПС", [1.04, 1.9, _, 22, 22, _, _, 90], "plastic", "#f1f1ee"],
  ["plastic", "TPU 95A", "TPU 95A", "ТПУ", [1.22, 0.026, _, 8.6, 39, _, _, _], "plastic", "#2b2b2b"],
  ["plastic", "Epoxy resin (cast)", "Эпоксидная смола (литая)", "", [1.2, 3.2, 0.35, _, 70, 0.2, _, 60], "plastic", "#cfc7a8"],

  // ---------- rubbers ----------
  ["elastomer", "Rubber NBR 70 Shore A", "Резина NBR 70 Shore A", "nitrile · БНК", [1.25, 0.0055, 0.49, _, _, _, _, _], "rubber"],
  ["elastomer", "Rubber EPDM 70 Shore A", "Резина EPDM 70 Shore A", "СКЭПТ", [1.15, 0.0055, 0.49, _, _, _, _, _], "rubber"],
  ["elastomer", "Rubber FKM 75 Shore A", "Резина FKM 75 Shore A", "Viton · СКФ", [1.85, 0.007, 0.49, _, _, _, _, _], "rubber"],
  ["elastomer", "Silicone rubber VMQ 60 Shore A", "Силиконовая резина VMQ 60 Shore A", "", [1.15, 0.0036, 0.49, _, _, _, _, _], "rubber", "#b9bcc0"],

  // ---------- composites ----------
  ["composite", "Carbon/epoxy, unidirectional (AS4/3501-6)", "Углепластик однонаправленный (AS4/3501-6)", "CFRP · УД", [1.6, 147, 0.27, _, 2280, _, _, -0.9], "comp"],
  ["composite", "Carbon/epoxy, woven fabric (AGP370-5H/3501-6S)", "Углепластик тканый (AGP370-5H/3501-6S)", "CFRP", [1.6, 77, 0.06, _, 963, _, _, 3.4], "comp"],
  ["composite", "E-glass/epoxy, unidirectional", "Стеклопластик однонаправленный (E-стекло/эпоксид)", "GFRP", [1.97, 41, 0.28, _, 1140, _, _, 7], "comp", "#b9c2a4"],
  ["composite", "E-glass/epoxy, woven fabric (M10E/3783)", "Стеклопластик тканый (M10E/3783)", "GFRP", [1.9, 24.5, 0.11, _, 433, _, _, _], "comp", "#b9c2a4"],
  ["composite", "Kevlar 49/epoxy, unidirectional", "Органопластик однонаправленный (Kevlar 49/эпоксид)", "AFRP", [1.38, 80, 0.34, _, 1400, _, _, -2], "comp", "#d6b84a"],
  ["composite", "FR-4 (glass/epoxy laminate)", "FR-4 (стеклотекстолит)", "EP GC 202 · СТЭФ", [1.85, 22, _, _, 300, 0.3, _, 14], "iec", "#5f7d4a"],

  // ---------- glass and ceramics ----------
  ["ceramic", "Glass (soda-lime)", "Стекло (натриево-кальциевое)", "float glass", [2.5, 70, 0.2, _, _, 1, 720, 9], "ceramic", "#cfe3e6"],
  ["ceramic", "Glass (borosilicate 3.3)", "Стекло (боросиликатное 3.3)", "ISO 3585 · Duran · Pyrex", [2.23, 64, 0.2, _, _, 1.2, 830, 3.3], "ceramic", "#dcecee"],
  ["ceramic", "Fused silica", "Кварцевое стекло", "SiO₂", [2.2, 73, 0.16, _, _, 1.3, 770, 0.57], "ceramic", "#e9f1f2"],
  ["ceramic", "Alumina 99.5 %", "Корунд 99,5 % (оксид алюминия)", "Al₂O₃", [3.9, 370, 0.22, _, 262, 30, 880, 8.2], "ceramic"],
  ["ceramic", "Zirconia (Y-TZP)", "Диоксид циркония (Y-TZP)", "ZrO₂", [6.02, 200, 0.3, _, _, 2.2, 400, 10.3], "ceramic"],
  ["ceramic", "Silicon carbide (sintered)", "Карбид кремния (спечённый)", "SSiC", [3.15, 410, 0.14, _, _, 125.6, 670, 4.02], "ceramic", "#4a4d52"],

  // ---------- woods and wood panels ----------
  ["wood", "Wood (oak)", "Дерево (дуб)", "white oak", [0.75, 12.3, _, _, _, 0.18, 1600, _], "wood", "#a47b4c"],
  ["wood", "Wood (beech)", "Дерево (бук)", "American beech", [0.72, 11.9, _, _, _, 0.17, 1600, _], "wood", "#caa27a"],
  ["wood", "Wood (birch)", "Дерево (берёза)", "yellow birch", [0.69, 13.9, _, _, _, 0.17, 1600, _], "wood", "#d9c19a"],
  ["wood", "Wood (maple)", "Дерево (клён)", "sugar maple", [0.71, 12.6, _, _, _, 0.17, 1600, _], "wood", "#dcc59f"],
  ["wood", "Wood (ash)", "Дерево (ясень)", "white ash", [0.67, 12, _, _, _, 0.16, 1600, _], "wood", "#d2b98f"],
  ["wood", "Wood (walnut)", "Дерево (орех)", "black walnut", [0.62, 11.6, _, _, _, 0.15, 1600, _], "wood", "#6b4a32"],
  ["wood", "Wood (teak)", "Дерево (тик)", "", [0.62, 10.7, _, _, _, 0.15, 1600, _], "wood", "#9c6b3c"],
  ["wood", "Wood (mahogany)", "Дерево (махагони)", "", [0.5, 10.3, _, _, _, 0.13, 1600, _], "wood", "#8a4b32"],
  ["wood", "Wood (pine, southern)", "Дерево (сосна южная)", "loblolly pine", [0.57, 12.3, _, _, _, 0.14, 1600, _], "wood", "#dcc08a"],
  ["wood", "Wood (pine, eastern white)", "Дерево (сосна веймутова)", "", [0.39, 8.5, _, _, _, 0.1, 1600, _], "wood", "#e3cf9f"],
  ["wood", "Wood (spruce)", "Дерево (ель)", "Sitka spruce", [0.45, 10.8, _, _, _, 0.12, 1600, _], "wood", "#e6d6ac"],
  ["wood", "Wood (Douglas fir)", "Дерево (дугласова пихта)", "", [0.54, 13.4, _, _, _, 0.14, 1600, _], "wood", "#d3a66e"],
  ["wood", "Wood (western red cedar)", "Дерево (туя гигантская, красный кедр)", "", [0.36, 7.7, _, _, _, 0.1, 1600, _], "wood", "#b5744a"],
  ["wood", "Wood (balsa)", "Дерево (бальза)", "", [0.18, 3.4, _, _, _, 0.06, 1600, _], "wood", "#ead9b5"],
  ["wood", "Plywood (birch)", "Фанера (берёзовая)", "EN 636 · ФК · ФСФ", [0.68, _, _, _, _, 0.17, 1600, _], "panel", "#d9c19a"],
  ["wood", "MDF", "МДФ", "EN 622-5", [0.75, 2.5, _, _, _, _, 1700, _], "panel", "#b89a6c"],
  ["wood", "Particleboard P2", "ДСП P2", "EN 312 · chipboard", [0.65, 1.6, _, _, _, 0.14, 1700, _], "panel", "#c6a877"],
  ["wood", "OSB/3", "OSB/3 (ОСП-3)", "EN 300", [0.6, 3.5, _, _, _, 0.13, 1700, _], "panel", "#c9a05a"],

  // ---------- other ----------
  ["other", "Concrete C25/30", "Бетон C25/30", "B30", [2.4, 31, 0.2, _, 2.6, 2, 1000, 10], "ec2"],
  ["other", "Water (20 °C)", "Вода (20 °C)", "H₂O", [0.998, _, _, _, _, 0.598, 4182, _], "crc", "#7fb2d9"],
];

/** The built-in library, in category order. */
/**
 * Public pages the values were compared with (2026-11): density, modulus, yield and tensile strength.
 * A material without an entry has only its `SOURCES` reference. Keys are material names.
 */
// prettier-ignore
export const CHECKED: Record<string, string> = {
  "Steel S235JR": "steelcalculator.pages.dev/reference/eu-steel-fy-fu/",
  "Steel S275JR": "steelcalculator.pages.dev/reference/eu-steel-fy-fu/",
  "Steel S355J2": "steelcalculator.pages.dev/reference/eu-steel-fy-fu/",
  "Steel S420N": "steelcalculator.pages.dev/reference/european-steel-properties/",
  "Steel S460N": "steelcalculator.pages.dev/reference/european-steel-properties/",
  "Steel S690QL": "shop.macsteel.co.za/SpecSheets/P_S690QL_0100.pdf",
  "Steel AISI 1018 (cold drawn)": "matweb.com/search/datasheettext.aspx?matid=6817",
  "Steel C45 (normalized)": "en.saarstahl.com/app/uploads/2024/03/20160401102929-0503_C45.pdf",
  "Steel 41Cr4 (quenched and tempered)": "www.saarstahl.com/app/uploads/2024/03/20160318090949-41Cr4-41CrS4.pdf",
  "Steel 34CrNiMo6 (quenched and tempered)": "www.marks-gmbh.de/afs/downloads/16582-datenblatt.pdf",
  "Steel 30KhGSA (quenched and tempered)": "metinvestholding.com/en/products/steel-grades/30khgsa",
  "Steel 65G (spring, quenched and tempered)": "metinvestholding.com/en/products/steel-grades/65g",
  "Stainless steel 1.4512 (X2CrTi12, ferritic)": "www.quality.marcegaglia.com/wp-content/uploads/2018/12/DOP_0101-055_409_LAF_EN10088-4_EN-exp2015-11-01.pdf",
  "Stainless steel 1.4021 (X20Cr13, QT700)": "www.rightonblackburns.co.uk/datasheets/view/stainless-steel-1-4021-420-bar",
  "Grey cast iron EN-GJL-250": "www.kippwerk.de/en/en-gjl-250",
  "Ductile cast iron EN-GJS-400-15": "www.jjsiddons.co.uk/?p=2252",
  "Ductile cast iron EN-GJS-500-7": "www.jjsiddons.co.uk/?p=2252",
  "Ductile cast iron EN-GJS-600-3": "www.jjsiddons.co.uk/?p=2252",
  "Ductile cast iron EN-GJS-700-2": "www.jjsiddons.co.uk/?p=2252",
  "Aluminium EN AW-5754 H22": "www.marks-gmbh.de/afs/downloads/AW-5754-datenblatt.pdf",
  "Aluminium EN AW-6082 T6": "www.rightonblackburns.co.uk/datasheets/view/Righton-Blackburns-Ltd_Aluminium-Alloy-6082-T6-T651-Sheet-Plate_148.pdf",
  "Cast aluminium EN AC-42100 T6 (AlSi7Mg0.3, sand cast)": "www.roth-giesserei.de/pdf/MechEigenschaftenAluTabelleHomepage2019Si7Mg.pdf",
  "Die cast aluminium A380": "dynacast.com/knowledge-center/dynamic-process-metal-selector",
  "Cast bronze CuSn12-C": "www.metalcentergroup.fi/media/2crp1tgl/cc483k-version1.pdf",
  "Gunmetal CuSn5Zn5Pb5-C": "www.kemper-group.com/en-en/casting-technology/gunmetal-multi-constituent-bronze/cusn5zn5pb5-c-gs/",
  "Aluminium bronze CuAl10Ni5Fe4": "www.makeitfrom.com/compare/UNS-C63000-CW307G-Aluminum-Nickel-Bronze/UNS-C17000-CW100C-Beryllium-Copper",
  "Titanium Ti-6Al-4V ELI": "ferrobend.com/specifications/astm/bars-rods/b348-b348m-grade-23",
  "Nickel 200": "www.specialmetals.com/documents/technical-bulletins/nickel-200.pdf",
  "Inconel 625 (annealed)": "www.langleyalloys.com/knowledge-advice/what-is-inconel-625-grade-2/",
  "Monel 400 (annealed)": "mechanicalc.com/reference/material-properties-tables",
  "Hastelloy C-276": "mechanicalc.com/reference/material-properties-tables",
  "Invar 36": "www.mcmaster.com/invar-round-stock",
  "Die cast magnesium AZ91D": "dynacast.com/knowledge-center/dynamic-process-metal-selector",
  "Zinc alloy Zamak 3": "eazall.com/zamak-3",
  "Zinc alloy Zamak 5": "eazall.com/zamak-5",
  "Lead": "en.wikipedia.org/wiki/Elastic_properties_of_the_elements_(data_page)",
  "Tungsten": "en.wikipedia.org/wiki/Elastic_properties_of_the_elements_(data_page)",
  "Molybdenum": "en.wikipedia.org/wiki/Elastic_properties_of_the_elements_(data_page)",
  "Silver": "en.wikipedia.org/wiki/Elastic_properties_of_the_elements_(data_page)",
  "Gold": "en.wikipedia.org/wiki/Elastic_properties_of_the_elements_(data_page)",
  "Polycarbonate": "www.ensingerplastics.com/en-us/shapes/polycarbonate-tecanat-natural",
  "Alumina 99.5 %": "www.coorstek.com/media/4235/advanced-alumina.pdf",
  "Zirconia (Y-TZP)": "www.coorstek.com/media/8908/semiconductor-oxides-material-properties-chart-02084.pdf",
  "Silicon carbide (sintered)": "www.syalons.com/wp-content/uploads/2018/03/sycarb-10-datasheet.pdf",
  "Wood (spruce)": "amesweb.info/Materials/Youngs-Modulus-of-Wood.aspx",
  "Wood (ash)": "amesweb.info/Materials/Youngs-Modulus-of-Wood.aspx",
  "Wood (walnut)": "www.engineeringtoolbox.com/timber-mechanical-properties-d_1789.html",
  "Steel (carbon)": "steelcalculator.pages.dev/reference/eu-steel-fy-fu/",
  // 1.382.0: second pass over the rows that had no reference.
  "Steel S960QL": "www.ssab.com/en/brands-and-products/strenx/product-offer/960/e-f",
  "Steel ASTM A36": "en.wikipedia.org/wiki/A36_steel",
  "Steel ASTM A572 Grade 50": "en.wikipedia.org/wiki/A572_steel",
  "Steel DC01 (cold rolled sheet)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10130.html",
  "Steel DC04 (deep drawing sheet)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10130.html",
  "Steel DX51D+Z (galvanized sheet)": "www.usske.sk/en/products/hot-dip-galvanized/drawing-steels",
  "Steel C35 (normalized)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10083.html",
  "Steel C60 (normalized)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10083.html",
  "Steel 11SMn30 (free cutting, cold drawn)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10277.html",
  "Steel 25CrMo4 (quenched and tempered)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10083.html",
  "Steel 42CrMo4 (quenched and tempered)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10083.html",
  "Steel 51CrV4 (spring, quenched and tempered)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10083.html",
  "Cast steel GE240": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10293.html",
  "Stainless steel 304": "www.thyssenkrupp-materials.co.uk/stainless-steel-304-14301.html",
  "Stainless steel 1.4301 (X5CrNi18-10)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4307 (X2CrNi18-9)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4305 (X8CrNiS18-9)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4310 (X10CrNi18-8)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4401 (X5CrNiMo17-12-2)": "www.thyssenkrupp-materials.co.uk/stainless-steel-316-14401.html",
  "Stainless steel 1.4404 (X2CrNiMo17-12-2)": "www.thyssenkrupp-materials.co.uk/stainless-steel-316l-14404.html",
  "Stainless steel 1.4571 (X6CrNiMoTi17-12-2)": "www.thyssenkrupp-materials.co.uk/stainless-steel-316ti-14571.html",
  "Stainless steel 1.4541 (X6CrNiTi18-10)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4539 (X1NiCrMoCu25-20-5)": "www.thyssenkrupp-materials.co.uk/stainless-steel-904l-14539.html",
  "Stainless steel 1.4016 (X6Cr17, ferritic)": "www.thyssenkrupp-materials.co.uk/stainless-steel-430-14016.html",
  "Stainless steel 1.4057 (X17CrNi16-2, QT800)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4542 (17-4 PH, P1070)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4462 (duplex 2205)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Stainless steel 1.4410 (super duplex 2507)": "roymech.org/Useful_Tables/Matter/Steel_Data/Steel-10088.html",
  "Cast iron": "www.mfgrobots.com/Article/material/metal/39356.html",
  "Grey cast iron EN-GJL-150": "www.mfgrobots.com/Article/material/metal/39354.html",
  "Grey cast iron EN-GJL-200": "www.mfgrobots.com/Article/material/metal/39355.html",
  "Grey cast iron EN-GJL-300": "www.kippwerk.de/en/en-gkl-300",
  "Aluminium 6061": "en.wikipedia.org/wiki/6061_aluminium_alloy",
  "Aluminium EN AW-1050A H14": "www.aalco.co.uk/datasheets/Aluminium-Alloy-1050A-H14-Sheet_57.ashx",
  "Aluminium EN AW-2024 T3": "www.aerospacemetals.com/wp-content/uploads/2023/06/Aluminum-2024-T3.pdf",
  "Aluminium EN AW-3003 H14": "www.referansmetal.com/alasimli-aluminyum/product/454/sac/ams-4008-almn1cu-3003-h14?lang=en",
  "Aluminium EN AW-5052 H32": "en.wikipedia.org/wiki/5052_aluminium_alloy",
  "Aluminium EN AW-5083 O/H111": "www.aalco.co.uk/datasheets/Aluminium-Alloy-5083-0-H111-Sheet-and-Plate_149.ashx",
  "Aluminium EN AW-6060 T6": "www.wieland.com/cn/content/download/17146/file/EN-AW-6060_EN.pdf",
  "Aluminium EN AW-6063 T6": "www.aalco.co.uk/datasheets/Aluminium-Alloy-6063-T6-Extrusions_158.ashx",
  "Aluminium EN AW-7075 T6": "en.wikipedia.org/wiki/7075_aluminium_alloy",
  "Cast aluminium EN AC-43000 T6 (AlSi10Mg)": "www.roth-giesserei.de/pdf/MechEigenschaftenAluTabelleHomepage2010Si10Mg.pdf",
  "Copper": "www.makeitfrom.com/material-properties/Annealed-OS050-C11000-Copper",
  "Brass CuZn37": "www.aalco.co.uk/datasheets/Copper-and-Copper-Alloys-CW508L-Tube_350.ashx",
  "Brass CuZn39Pb3 (free cutting)": "www.rightonblackburns.co.uk/datasheets/view/Righton-Blackburns-Ltd_Copper-and-Copper-Alloys-CW614N-CZ121-Bar_31.pdf",
  "Bronze CuSn8 (phosphor bronze)": "www.kemper-group.com/en-en/rolled-products/alloys/cusn8/",
  "Titanium Grade 2": "aircraftmaterials.com/data/titanium/cpgr2.html",
  "Inconel 718 (aged)": "premiumalloys.com/products/inconel-718/ams-5663/",
  "Magnesium AZ31B H24": "www.techsteel.net/alloy/az31b-h24",
  "Zinc": "en.wikipedia.org/wiki/Zinc",
  "ABS": "en.wikipedia.org/wiki/Acrylonitrile_butadiene_styrene",
  "Nylon PA12 (laser sintered)": "store.eos.info/products/pa-2200-polyamide-12",
  "POM-C (acetal copolymer)": "en.wikipedia.org/wiki/Polyoxymethylene",
  "Polypropylene PP-H": "en.wikipedia.org/wiki/Polypropylene",
  "Polyethylene PE-UHMW": "www.roechling.com/us/industrial/materials/thermoplastics/industrial-plastics/pe/pe-uhmw-pe-1000/polystone-m-grey-astm-774088",
  "PTFE": "en.wikipedia.org/wiki/Polytetrafluoroethylene",
  "Polystyrene PS": "en.wikipedia.org/wiki/Polystyrene",
  "TPU 95A": "www.utwente.nl/en/rpl/Data%20sheets/Ultimaker%203/TPU%2095A.pdf",
  "E-glass/epoxy, woven fabric (M10E/3783)": "www.performance-composites.com/carbonfibre/mechanicalproperties_2.asp",
  "FR-4 (glass/epoxy laminate)": "en.wikipedia.org/wiki/FR-4",
  "Glass (soda-lime)": "en.wikipedia.org/wiki/Soda%E2%80%93lime_glass",
  "Glass (borosilicate 3.3)": "cdn.standards.iteh.ai/samples/8993/bb194e27aa514eac8aa9c927feeed624/ISO-3585-1976.pdf",
  "Fused silica": "en.wikipedia.org/wiki/Fused_quartz",
  "Wood (oak)": "www.wood-database.com/white-oak/",
  "Wood (beech)": "www.wood-database.com/american-beech/",
  "Wood (birch)": "www.wood-database.com/yellow-birch/",
  "Wood (maple)": "www.wood-database.com/hard-maple/",
  "Wood (pine, southern)": "www.wood-database.com/loblolly-pine/",
  "Wood (pine, eastern white)": "www.wood-database.com/eastern-white-pine/",
  "Wood (western red cedar)": "www.wood-database.com/western-red-cedar/",
  "Plywood (birch)": "en.wikipedia.org/wiki/Plywood",
  "Concrete C25/30": "eurocodeapplied.com/design/en1992/concrete-design-properties",
  // 1.385.0: tool and bearing steels, titanium, A500, C22.
  "Steel 100Cr6 (bearing)": "lucefin.com/oaleekso/files_mf/1523536908100Cr6.pdf",
  "Tool steel X153CrMoV12": "xometry.pro/wp-content/uploads/2023/09/Steel-1.2379-X153CrMo12-SKD11-annealed.pdf",
  "Tool steel X40CrMoV5-1": "www.oberste-beulmann.de/Dateien/Datenblaetter/1.2344.efs.en.pdf",
  "Tool steel 90MnCrV8": "www.oberste-beulmann.de/Dateien/Datenblaetter/1.2842.en.pdf",
  "High speed steel HS6-5-2": "www.materialhub.de/en/materials/key-to-metals-hs6-5-2c-en",
  "Stainless steel 1.4125 (X105CrMo17)": "lucefin.com/oaleekso/files_mf/15235415301.4125A440C.pdf",
  "Titanium Grade 4": "sd-metals.bibus.com/de-en/materials/itm/Titanium-Grade-4/",
  "Titanium Ti-6Al-4V": "www.ulbrich.com/alloys/ti-6-al-4-v-uns-r56400/",
  "Steel ASTM A500 Grade B (shaped tube)": "major-metals-website.pages.dev/welded-steel-tubing/astm-a500",
  "Steel C22 (normalized)": "en.saarstahl.com/app/uploads/2024/03/20160401100253-0402_C22.pdf",
  // 1.399.0: four plastics from their makers' data sheets.
  "PLA": "cdn.shopify.com/s/files/1/1223/5992/files/PLA_4043D_TDS.pdf",
  "PETG": "protolabs.com/media/pzub5tfo/eastar-6763.pdf",
  "PEI (Ultem 1000)": "cdn.shopify.com/s/files/1/0260/7421/files/ULTEM_1000_DATA_SHEET.pdf",
  "Polyethylene PE-HD": "www.oadbyplastics.co.uk/wp-content/uploads/2025/11/PE-HD-300-Technical-Datasheet.pdf",
  // 1.405.0: stock shape and board makers' data sheets.
  "POM (Delrin)": "polymershapes.com/wp-content/uploads/2025/07/DELRIN_150_Series_Nat_Acetal_Homopolymer_14.pdf",
  "PEEK": "www.curbellplastics.com/wp-content/uploads/2022/11/TECAPEEK-Natural-Data-Sheet.pdf",
  "PET (PET-P)": "plasticsintl.com/media/ocglsyfe/pet-tecapet-data-sheet.pdf",
  "OSB/3": "forest.one/media/sparsh/product_attachment/EGGER_-_OSB_TDS.pdf",
  // 1.407.0: PA66 stock shapes and the PLEXIGLAS GS/XT sheet.
  "Nylon PA66": "www.polymershapes.com/wp-content/uploads/2020/04/Polymershapes_Ensigner_DataSheet-TECAMID-66-natural.pdf",
  "PMMA (acrylic)": "www.voskunststoffen.nl/files/166151/datasheet%20plexiglas%20XT%20GS.pdf",
  // 1.408.0: Oregon State's table from the USDA Wood Handbook.
  "Wood (Douglas fir)": "owic.oregonstate.edu/node/68",
};

export const LIBRARY: Material[] = ROWS.map(([cat, name, , eq, [density, E, nu, sy, su, k, cp, alpha], src, color]) =>
  ({ name, density, cat, eq, E, nu, sy, su, k, cp, alpha, src, ref: CHECKED[name], color: color ?? CATEGORIES.find(c => c.id === cat)!.color }));

/** Russian names of the materials, categories and sources (spread into the dictionary in i18n.ru.ts). */
export const MATERIAL_RU: Record<string, string> = Object.fromEntries([
  ...ROWS.filter(r => r[2] !== r[1]).map(r => [r[1], r[2]] as [string, string]),
  ...CATEGORIES.map(c => [c.name, c.ru] as [string, string]),
  ...Object.values(SOURCES).filter(s => s.ru).map(s => [s.text, s.ru!] as [string, string]),
]);

// ---------- the user's own materials (this browser) ----------
const STORE = "mc:materials";
const NUMS = ["E", "nu", "sy", "su", "k", "cp", "alpha"] as const;
export type MatNum = typeof NUMS[number];
export const MAT_NUMS: readonly MatNum[] = NUMS;

/** A stored or imported custom material, or null when it is not usable. */
export function validMaterial(x: unknown): Material | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  const density = Number(o.density);
  if (!name || !(density > 0) || !isFinite(density)) return null;
  const m: Material = { name, density, cat: "custom" };
  for (const k of NUMS) { const v = o[k]; if (typeof v === "number" && isFinite(v)) m[k] = v; }
  if (typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color)) m.color = o.color.toLowerCase();
  if (typeof o.eq === "string" && o.eq.trim()) m.eq = o.eq.trim().slice(0, 120);
  return m;
}

export function parseCustom(text: string | null): Material[] {
  try {
    const a: unknown = JSON.parse(text ?? "[]");
    if (!Array.isArray(a)) return [];
    const seen = new Set<string>();
    return a.map(validMaterial).filter((m): m is Material => !!m && !seen.has(m.name) && !!seen.add(m.name));
  } catch { return []; }
}

export function customMaterials(): Material[] {
  try { return typeof localStorage === "undefined" ? [] : parseCustom(localStorage.getItem(STORE)); } catch { return []; }
}

/** Adds or replaces (by name) one of the user's materials; false when the name is a built-in one. */
export function saveCustom(m: Material): boolean {
  const v = validMaterial(m);
  if (!v || LIBRARY.some(x => x.name.toLowerCase() === v.name.toLowerCase())) return false;
  const all = customMaterials().filter(x => x.name !== v.name);
  all.push(v);
  try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { return false; }
  return true;
}

export function removeCustom(name: string) {
  try { localStorage.setItem(STORE, JSON.stringify(customMaterials().filter(x => x.name !== name))); } catch { /* private mode */ }
}

/** Built-in materials, then the user's own. */
export function allMaterials(): Material[] { return [...LIBRARY, ...customMaterials()]; }

/** A material by its name (case-insensitive), the user's own included. */
export function findMaterial(name: string | null | undefined): Material | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return LIBRARY.find(m => m.name.toLowerCase() === n) ?? customMaterials().find(m => m.name.toLowerCase() === n);
}

/** What a document stores for a material: every known property, so the file stands alone. */
export function toRef(m: Material): MatRef {
  const r: MatRef = { name: m.name, density: m.density };
  if (m.cat !== "custom") r.cat = m.cat;
  for (const k of NUMS) if (typeof m[k] === "number") r[k] = m[k];
  if (m.color) r.color = m.color;
  return r;
}

/** The properties of a document's material: its own, filled in from the library entry of the same name. */
export function resolveRef(r: MatRef): Material {
  const lib = findMaterial(r.name);
  return { ...(lib && lib.density === r.density ? lib : {}), ...r, cat: r.cat ?? lib?.cat ?? "custom" };
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[\s·.,()/_-]+/g, "");

/**
 * Materials matching every word of the query in the name, its translation or the other designations
 * ("1.4301", "aisi 304", "д16т", "сталь 45"); names that start with the query come first.
 */
export function searchMaterials(list: Material[], query: string, tr: (s: string) => string = s => s): Material[] {
  const words = query.trim().split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  if (!words.length) return list;
  const whole = norm(query);
  const scored: [Material, number][] = [];
  for (const m of list) {
    const name = norm(m.name), loc = norm(tr(m.name)), eq = norm(m.eq ?? "");
    const hay = `${name}|${loc}|${eq}`;
    if (!words.every(w => hay.includes(w))) continue;
    scored.push([m, name.startsWith(whole) || loc.startsWith(whole) ? 0 : name.includes(whole) || loc.includes(whole) ? 1 : eq.includes(whole) ? 2 : 3]);
  }
  return scored.sort((a, b) => a[1] - b[1]).map(s => s[0]);
}

/** #rrggbb → [r, g, b] in 0..1. */
export function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
