// Vendor parts (FR-ASM-028): a model downloaded from a supplier's catalogue keeps where it came from.
// McMaster-Carr's terms let a customer download a part's CAD model to decide on and buy it, but not
// scrape, frame or redistribute them, so the app never fetches anything from mcmaster.com: the user
// downloads the 3-D STEP file there and drops it on the assembly. Its file name (or the STEP header)
// gives the part number; the part keeps it with the vendor and a link back to the product page, so the
// BOM can say where to buy it.
import type { PartDoc } from "../model/types";

export const MCMASTER = "McMaster-Carr";
/** McMaster-Carr part numbers: 4 or 5 digits, a letter, 1 to 4 digits ("91290A115", "5972K91"). */
const PN = /^(\d{4,5}[A-Z]\d{1,4})(?:[_\s-]+(.*))?$/i;

export interface VendorPart { vendor: string; number: string; description: string; url: string }

export const mcmasterUrl = (pn: string) => `https://www.mcmaster.com/${encodeURIComponent(pn.toUpperCase())}/`;

/**
 * The McMaster-Carr part a downloaded file is, from its name ("91290A115_Black-Oxide Alloy Steel Socket
 * Head Screw.STEP") or, failing that, a STEP header that names McMaster-Carr and a product with a part
 * number. Null for anything else.
 */
export function mcmasterPart(fileName: string, head = ""): VendorPart | null {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();
  let m = PN.exec(base);
  let description = m?.[2]?.replace(/_/g, " ").trim() ?? "";
  if (!m && /mcmaster/i.test(head)) {
    const prod = /PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/i.exec(head);
    const hit = prod && (PN.exec(prod[1].trim()) ?? PN.exec(prod[2].trim()));
    if (hit) { m = hit; description = hit[2]?.trim() ?? ""; }
  }
  if (!m) return null;
  const number = m[1].toUpperCase();
  return { vendor: MCMASTER, number, description, url: mcmasterUrl(number) };
}

/** Writes the vendor part into the part's properties (part number, description, custom Vendor / Vendor URL). */
export function tagVendor(pd: PartDoc, v: VendorPart) {
  pd.props = {
    ...pd.props,
    partNumber: v.number,
    ...(v.description ? { description: v.description } : {}),
    custom: { ...pd.props?.custom, Vendor: v.vendor, "Vendor URL": v.url },
  };
}

/** The vendor and its product link, when the part came from one (only https links are returned). */
export function vendorOf(pd: PartDoc | null | undefined): { vendor: string; url: string } | null {
  const c = pd?.props?.custom, vendor = c?.Vendor, url = c?.["Vendor URL"];
  return vendor && url && /^https:\/\//i.test(url) ? { vendor, url } : null;
}
