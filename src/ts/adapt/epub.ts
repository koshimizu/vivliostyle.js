/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Trim-marks Inc.
 * Copyright 2018 Vivliostyle Foundation
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview Epub - Deal with META-INF/ and .opf files in EPUB container.
 */
import * as Base from "../adapt/base";
import * as Cfi from "../adapt/cfi";
import * as CssCasc from "../adapt/csscasc";
import * as CssParse from "../adapt/cssparse";
import * as CssTok from "../adapt/csstok";
import * as Exprs from "../adapt/expr";
import * as Font from "../adapt/font";
import * as Net from "../adapt/net";
import * as Ops from "../adapt/ops";
import * as Sha1 from "../adapt/sha1";
import * as Task from "../adapt/task";
import * as Toc from "../adapt/toc";
import * as Vgen from "../adapt/vgen";
import * as Vtree from "../adapt/vtree";
import * as XmlDoc from "../adapt/xmldoc";
import * as Asserts from "../vivliostyle/asserts";
import * as Constants from "../vivliostyle/constants";
import * as Counters from "../vivliostyle/counters";
import * as Logging from "../vivliostyle/logging";

export type Position = {
  spineIndex: number;
  pageIndex: number;
  offsetInItem: number;
};

export class EPUBDocStore extends Ops.OPSDocStore {
  plainXMLStore: XmlDoc.XMLDocStore;
  jsonStore: Net.JSONStore;
  opfByURL: { [key: string]: OPFDoc } = {};
  primaryOPFByEPubURL: { [key: string]: OPFDoc } = {};
  deobfuscators: { [key: string]: (p1: Blob) => Task.Result<Blob> } = {};
  documents: { [key: string]: Task.Result<XmlDoc.XMLDocHolder> } = {};

  constructor() {
    super(null);
    this.fontDeobfuscator = this.makeDeobfuscatorFactory();
    this.plainXMLStore = XmlDoc.newXMLDocStore();
    this.jsonStore = Net.newJSONStore();
  }

  makeDeobfuscatorFactory():
    | ((p1: string) => ((p1: Blob) => Task.Result<Blob>) | null)
    | null {
    const self = this;
    return (url: string): ((p1: Blob) => Task.Result<Blob>) | null => {
      return self.deobfuscators[url];
    };
  }

  loadAsPlainXML(
    url: string,
    opt_required?: boolean,
    opt_message?: string
  ): Task.Result<XmlDoc.XMLDocHolder> {
    return this.plainXMLStore.load(
      url,
      opt_required,
      opt_message
    ) as Task.Result<XmlDoc.XMLDocHolder>;
  }

  startLoadingAsPlainXML(url: string): void {
    this.plainXMLStore.fetch(url);
  }

  loadAsJSON(
    url: string,
    opt_required?: boolean,
    opt_message?: string
  ): Task.Result<Base.JSON> {
    return this.jsonStore.load(url, opt_required, opt_message);
  }

  startLoadingAsJSON(url: string): void {
    this.jsonStore.fetch(url);
  }

  loadPubDoc(url: string, haveZipMetadata: boolean): Task.Result<OPFDoc> {
    const frame: Task.Frame<OPFDoc> = Task.newFrame("loadPubDoc");

    Net.ajax(url, null, "HEAD").then(response => {
      if (response.status >= 400) {
        // This url can be the root of an unzipped EPUB.
        this.loadEPUBDoc(url, haveZipMetadata).then(opf => {
          if (opf) {
            frame.finish(opf);
            return;
          }
          Logging.logger.error(
            `Failed to fetch a source document from ${url} (${response.status}${
              response.statusText ? " " + response.statusText : ""
            })`
          );
          frame.finish(null);
        });
      } else {
        if (
          !response.status &&
          !response.responseXML &&
          !response.responseText &&
          !response.responseBlob &&
          !response.contentType
        ) {
          // Empty response
          if (/\/[^/.]+(?:[#?]|$)/.test(url)) {
            // Adding trailing "/" may solve the problem.
            url = url.replace(/([#?]|$)/, "/$1");
          } else {
            // Ignore empty response of HEAD request, it may become OK with GET request.
          }
        }
        if (
          response.contentType == "application/oebps-package+xml" ||
          /\.opf(?:[#?]|$)/.test(url)
        ) {
          // EPUB OPF
          const [, pubURL, root] = url.match(/^((?:.*\/)?)([^/]*)$/);
          this.loadOPF(pubURL, root, haveZipMetadata).thenFinish(frame);
        } else if (
          response.contentType == "application/ld+json" ||
          response.contentType == "application/webpub+json" ||
          response.contentType == "application/audiobook+json" ||
          response.contentType == "application/json" ||
          /\.json(?:ld)?(?:[#?]|$)/.test(url)
        ) {
          // Web Publication Manifest
          this.loadAsJSON(url, true).then(manifestObj => {
            if (!manifestObj) {
              Logging.logger.error(
                `Received an empty response for ${url}. This may be caused by the server not allowing cross-origin resource sharing (CORS).`
              );
              frame.finish(null);
              return;
            }
            const opf = new OPFDoc(this, url);
            opf.initWithWebPubManifest(manifestObj).then(() => {
              frame.finish(opf);
            });
          });
        } else {
          // Web Publication primary entry (X)HTML
          this.loadWebPub(url).then(opf => {
            if (opf) {
              frame.finish(opf);
              return;
            }
            // This url can be the root of an unzipped EPUB.
            this.loadEPUBDoc(url, haveZipMetadata).then(opf => {
              if (opf) {
                frame.finish(opf);
                return;
              }
              Logging.logger.error(`Failed to load ${url}.`);
              frame.finish(null);
            });
          });
        }
      }
    });
    return frame.result();
  }

  loadEPUBDoc(url: string, haveZipMetadata: boolean): Task.Result<OPFDoc> {
    const frame: Task.Frame<OPFDoc> = Task.newFrame("loadEPUBDoc");
    if (!url.endsWith("/")) {
      url = url + "/";
    }
    if (haveZipMetadata) {
      this.startLoadingAsJSON(url + "?r=list");
    }
    this.startLoadingAsPlainXML(url + "META-INF/encryption.xml");
    const containerURL = url + "META-INF/container.xml";
    this.loadAsPlainXML(containerURL).then(containerXML => {
      if (containerXML) {
        const roots = containerXML
          .doc()
          .child("container")
          .child("rootfiles")
          .child("rootfile")
          .attribute("full-path");
        for (const root of roots) {
          if (root) {
            this.loadOPF(url, root, haveZipMetadata).thenFinish(frame);
            return;
          }
        }
        frame.finish(null);
      }
    });
    return frame.result();
  }

  loadOPF(
    pubURL: string,
    root: string,
    haveZipMetadata: boolean
  ): Task.Result<OPFDoc> {
    const self = this;
    const url = pubURL + root;
    let opf = self.opfByURL[url];
    if (opf) {
      return Task.newResult(opf);
    }
    const frame: Task.Frame<OPFDoc> = Task.newFrame("loadOPF");
    self
      .loadAsPlainXML(url, true, `Failed to fetch EPUB OPF ${url}`)
      .then(opfXML => {
        if (!opfXML) {
          Logging.logger.error(
            `Received an empty response for EPUB OPF ${url}. This may be caused by the server not allowing cross-origin resource sharing (CORS).`
          );
        } else {
          self
            .loadAsPlainXML(`${pubURL}META-INF/encryption.xml`)
            .then(encXML => {
              const zipMetadataResult = haveZipMetadata
                ? self.loadAsJSON(`${pubURL}?r=list`)
                : Task.newResult(null);
              zipMetadataResult.then(zipMetadata => {
                opf = new OPFDoc(self, pubURL);
                opf
                  .initWithXMLDoc(
                    opfXML,
                    encXML,
                    zipMetadata,
                    `${pubURL}?r=manifest`
                  )
                  .then(() => {
                    self.opfByURL[url] = opf;
                    self.primaryOPFByEPubURL[pubURL] = opf;
                    frame.finish(opf);
                  });
              });
            });
        }
      });
    return frame.result();
  }

  loadWebPub(url: string): Task.Result<OPFDoc> {
    const frame: Task.Frame<OPFDoc> = Task.newFrame("loadWebPub");

    // Load the primary entry page (X)HTML
    this.load(url).then(xmldoc => {
      if (!xmldoc) {
        Logging.logger.error(
          `Received an empty response for ${url}. This may be caused by the server not allowing cross-origin resource sharing (CORS).`
        );
      } else if (
        xmldoc.document.querySelector(
          "a[href='META-INF/'],a[href$='/META-INF/']"
        )
      ) {
        // This is likely the directory listing of unzipped EPUB top directory
        frame.finish(null);
      } else {
        const doc = xmldoc.document;
        const opf = new OPFDoc(this, url);

        if (doc.body) {
          doc.body.setAttribute("data-vivliostyle-primary-entry", true);
        }
        // Find manifest, W3C WebPublication or Readium Web Publication Manifest
        const manifestLink = doc.querySelector(
          "link[rel='publication'],link[rel='manifest'][type='application/webpub+json']"
        );
        if (manifestLink) {
          const href = manifestLink.getAttribute("href");
          if (/^#/.test(href)) {
            const manifestObj = Base.stringToJSON(
              doc.getElementById(href.substr(1)).textContent
            );
            opf.initWithWebPubManifest(manifestObj, doc).then(() => {
              frame.finish(opf);
            });
          } else {
            this.loadAsJSON(
              (manifestLink as any).href || manifestLink.getAttribute("href")
            ).then(manifestObj => {
              opf.initWithWebPubManifest(manifestObj, doc).then(() => {
                frame.finish(opf);
              });
            });
          }
        } else {
          // No manifest
          opf.initWithWebPubManifest({}, doc).then(() => {
            if (opf.xhtmlToc && opf.xhtmlToc.src === xmldoc.url) {
              // xhtmlToc is the primari entry (X)HTML
              if (
                !doc.querySelector(
                  "[role=doc-toc], [role=directory], nav, .toc, #toc"
                )
              ) {
                // TOC is not found in the primari entry (X)HTML
                opf.xhtmlToc = null;
              }
            }
            frame.finish(opf);
          });
        }
      }
    });
    return frame.result();
  }

  addDocument(url: string, doc: Document) {
    const frame = Task.newFrame<XmlDoc.XMLDocHolder>("EPUBDocStore.load");
    const docURL = Base.stripFragment(url);
    const r = (this.documents[docURL] = this.parseOPSResource({
      status: 200,
      statusText: "",
      url: docURL,
      contentType: (doc as any).contentType,
      responseText: null,
      responseXML: doc,
      responseBlob: null
    }));
    r.thenFinish(frame);
    return frame.result();
  }

  /**
   * @override
   */
  load(url: string): Task.Result<XmlDoc.XMLDocHolder> {
    const docURL = Base.stripFragment(url);
    let r = this.documents[docURL];
    if (r) {
      return r.isPending() ? r : Task.newResult(r.get());
    } else {
      const frame = Task.newFrame<XmlDoc.XMLDocHolder>("EPUBDocStore.load");
      r = super.load(
        docURL,
        true,
        `Failed to fetch a source document from ${docURL}`
      );
      r.then((xmldoc: XmlDoc.XMLDocHolder) => {
        if (!xmldoc) {
          if (docURL.startsWith("data:")) {
            Logging.logger.error(`Failed to load ${docURL}. Invalid data.`);
          } else if (
            docURL.startsWith("http:") &&
            Base.baseURL.startsWith("https:")
          ) {
            Logging.logger.error(
              `Failed to load ${docURL}. Mixed Content ("http:" content on "https:" context) is not allowed.`
            );
          } else {
            Logging.logger.error(
              `Received an empty response for ${docURL}. This may be caused by the server not allowing cross-origin resource sharing (CORS).`
            );
          }
        } else {
          frame.finish(xmldoc);
        }
      });
      return frame.result();
    }
  }
}

export type OPFItemParam = {
  url: string;
  index: number;
  startPage: number | null;
  skipPagesBefore: number | null;
};

export class OPFItem {
  id: string | null = null;
  src: string = "";
  mediaType: string | null = null;
  title: string | null = null;
  itemRefElement: Element | null = null;
  spineIndex: number = -1;
  compressedSize: number = 0;
  compressed: boolean | null = null;
  epage: number = 0;
  epageCount: number = 0;
  startPage: number | null = null;
  skipPagesBefore: number | null = null;
  itemProperties: { [key: string]: boolean };

  constructor() {
    this.itemProperties = Base.emptyObj;
  }

  initWithElement(itemElem: Element, opfURL: string): void {
    this.id = itemElem.getAttribute("id");
    this.src = Base.resolveURL(itemElem.getAttribute("href"), opfURL);
    this.mediaType = itemElem.getAttribute("media-type");
    const propStr = itemElem.getAttribute("properties");
    if (propStr) {
      this.itemProperties = Base.arrayToSet(propStr.split(/\s+/));
    }
  }

  initWithParam(param: OPFItemParam) {
    this.spineIndex = param.index;
    this.id = `item${param.index + 1}`;
    this.src = param.url;
    this.startPage = param.startPage;
    this.skipPagesBefore = param.skipPagesBefore;
  }
}

export function getOPFItemId(item: OPFItem): string | null {
  return item.id;
}

export function makeDeobfuscator(uid: string): (p1: Blob) => Task.Result<Blob> {
  // TODO: use UTF8 of uid
  const sha1Sum = Sha1.bytesToSHA1Int8(uid);
  return blob => {
    const frame = Task.newFrame("deobfuscator") as Task.Frame<Blob>;
    let head;
    let tail;
    if (blob.slice) {
      head = blob.slice(0, 1040);
      tail = blob.slice(1040, blob.size);
    } else {
      head = blob["webkitSlice"](0, 1040);
      tail = blob["webkitSlice"](1040, blob.size - 1040);
    }
    Net.readBlob(head).then(buf => {
      const dataView = new DataView(buf);
      for (let k = 0; k < dataView.byteLength; k++) {
        let b = dataView.getUint8(k);
        b ^= sha1Sum[k % 20];
        dataView.setUint8(k, b);
      }
      frame.finish(Net.makeBlob([dataView, tail]));
    });
    return frame.result();
  };
}

export function makeObfuscationKey(uid: string): string {
  return `1040:${Sha1.bytesToSHA1Hex(uid)}`;
}

export type RawMetaItem = {
  name: string;
  value: string;
  id: string | null;
  refines: string | null;
  scheme: string | null;
  lang: string | null;
  order: number;
};

export const predefinedPrefixes = {
  dcterms: "http://purl.org/dc/terms/",
  marc: "http://id.loc.gov/vocabulary/",
  media: "http://www.idpf.org/epub/vocab/overlays/#",
  rendition: "http://www.idpf.org/vocab/rendition/#",
  onix: "http://www.editeur.org/ONIX/book/codelists/current.html#",
  xsd: "http://www.w3.org/2001/XMLSchema#"
};

export const defaultIRI = "http://idpf.org/epub/vocab/package/#";

export const metaTerms = {
  language: `${predefinedPrefixes["dcterms"]}language`,
  title: `${predefinedPrefixes["dcterms"]}title`,
  creator: `${predefinedPrefixes["dcterms"]}creator`,
  layout: `${predefinedPrefixes["rendition"]}layout`,
  titleType: `${defaultIRI}title-type`,
  displaySeq: `${defaultIRI}display-seq`,
  alternateScript: `${defaultIRI}alternate-script`
};

export function getMetadataComparator(
  term: string,
  lang: string
): (p1: Base.JSON, p2: Base.JSON) => number {
  const empty = {};
  return (item1, item2) => {
    let m1;
    let m2;
    const r1 = item1["r"] || empty;
    const r2 = item2["r"] || empty;
    if (term == metaTerms.title) {
      m1 = r1[metaTerms.titleType] == "main";
      m2 = r2[metaTerms.titleType] == "main";
      if (m1 != m2) {
        return m1 ? -1 : 1;
      }
    }
    let i1 = parseInt(r1[metaTerms.displaySeq], 10);
    if (isNaN(i1)) {
      i1 = Number.MAX_VALUE;
    }
    let i2 = parseInt(r2[metaTerms.displaySeq], 10);
    if (isNaN(i2)) {
      i2 = Number.MAX_VALUE;
    }
    if (i1 != i2) {
      return i1 - i2;
    }
    if (term != metaTerms.language && lang) {
      m1 = (r1[metaTerms.language] || r1[metaTerms.alternateScript]) == lang;
      m2 = (r2[metaTerms.language] || r2[metaTerms.alternateScript]) == lang;
      if (m1 != m2) {
        return m1 ? -1 : 1;
      }
    }
    return item1["o"] - item2["o"];
  };
}

export function readMetadata(
  mroot: XmlDoc.NodeList,
  prefixes: string | null
): Base.JSON {
  // Parse prefix map (if any)
  let prefixMap;
  if (!prefixes) {
    prefixMap = predefinedPrefixes;
  } else {
    prefixMap = {};
    for (const pn in predefinedPrefixes) {
      prefixMap[pn] = predefinedPrefixes[pn];
    }
    let r;

    // This code permits any non-ASCII characters in the name to avoid bloating
    // the pattern.
    while (
      (r = prefixes.match(
        /^\s*([A-Z_a-z\u007F-\uFFFF][-.A-Z_a-z0-9\u007F-\uFFFF]*):\s*(\S+)/
      )) != null
    ) {
      prefixes = prefixes.substr(r[0].length);
      prefixMap[r[1]] = r[2];
    }
  }
  const resolveProperty = (val: string | null): string | null => {
    if (val) {
      const r = val.match(/^\s*(([^:]*):)?(\S+)\s*$/);
      if (r) {
        const iri = r[2] ? prefixMap[r[2]] : defaultIRI;
        if (iri) {
          return iri + r[3];
        }
      }
    }
    return null;
  };
  let order = 1;

  // List of metadata items.
  const rawItems = mroot.childElements().forEachNonNull((node: Element) => {
    if (node.localName == "meta") {
      const p = resolveProperty((node as Element).getAttribute("property"));
      if (p) {
        return {
          name: p,
          value: node.textContent,
          id: (node as Element).getAttribute("id"),
          order: order++,
          refines: (node as Element).getAttribute("refines"),
          lang: null,
          scheme: resolveProperty((node as Element).getAttribute("scheme"))
        };
      }
    } else if (node.namespaceURI == Base.NS.DC) {
      return {
        name: predefinedPrefixes["dcterms"] + node.localName,
        order: order++,
        lang: (node as Element).getAttribute("xml:lang"),
        value: node.textContent,
        id: (node as Element).getAttribute("id"),
        refines: null,
        scheme: null
      };
    }
    return null;
  });

  // Items grouped by their target id.
  const rawItemsByTarget = Base.multiIndexArray(
    rawItems,
    rawItem => rawItem.refines
  );
  const makeMetadata = (map: {
    [key: string]: any[];
  }): { [key: string]: any[] } =>
    Base.mapObj(map, (rawItemArr, itemName) =>
      rawItemArr.map(rawItem => {
        const entry = { v: rawItem.value, o: rawItem.order };
        if (rawItem.schema) {
          entry["s"] = rawItem.scheme;
        }
        if (rawItem.id || rawItem.lang) {
          let refs = rawItemsByTarget[rawItem.id];
          if (refs || rawItem.lang) {
            if (rawItem.lang) {
              // Special handling for xml:lang
              const langItem = {
                name: metaTerms.language,
                value: rawItem.lang,
                lang: null,
                id: null,
                refines: rawItem.id,
                scheme: null,
                order: rawItem.order
              };
              if (refs) {
                refs.push(langItem);
              } else {
                refs = [langItem];
              }
            }
            const entryMap = Base.multiIndexArray(
              refs,
              rawItem => rawItem.name
            );
            entry["r"] = makeMetadata(entryMap);
          }
        }
        return entry;
      })
    );
  const metadata = makeMetadata(
    Base.multiIndexArray(rawItems, rawItem =>
      rawItem.refines ? null : rawItem.name
    )
  );
  let lang = null;
  if (metadata[metaTerms.language]) {
    lang = metadata[metaTerms.language][0]["v"];
  }
  const sortMetadata = (metadata: { [key: string]: any[] }) => {
    for (const term in metadata) {
      const arr = metadata[term];
      arr.sort(getMetadataComparator(term, lang));
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i]["r"];
        if (r) {
          sortMetadata(r);
        }
      }
    }
  };
  sortMetadata(metadata);
  return metadata;
}

export function getMathJaxHub(): object {
  const math = window["MathJax"];
  if (math) {
    return math["Hub"];
  }
  return null;
}

export function checkMathJax(): void {
  if (getMathJaxHub()) {
    CssCasc.supportedNamespaces[Base.NS.MATHML] = true;
  }
}

export const supportedMediaTypes = {
  "application/xhtml+xml": true,
  "image/jpeg": true,
  "image/png": true,
  "image/svg+xml": true,
  "image/gif": true,
  "audio/mp3": true
};

export const transformedIdPrefix = "viv-id-";

export class OPFDoc {
  opfXML: XmlDoc.XMLDocHolder = null;
  encXML: XmlDoc.XMLDocHolder = null;
  items: OPFItem[] = null;
  spine: OPFItem[] = null;
  itemMap: { [key: string]: OPFItem } = null;
  itemMapByPath: { [key: string]: OPFItem } = null;
  uid: string | null = null;
  bindings: { [key: string]: string } = {};
  lang: string | null = null;
  epageCount: number = 0;
  prePaginated: boolean = false;
  epageIsRenderedPage: boolean = true;
  epageCountCallback: (p1: number) => void | null = null;
  metadata: Base.JSON = {};
  ncxToc: OPFItem = null;
  xhtmlToc: OPFItem = null;
  cover: OPFItem = null;
  fallbackMap: { [key: string]: string } = {};
  pageProgression: Constants.PageProgression | null = null;
  documentURLTransformer: Base.DocumentURLTransformer;

  constructor(
    public readonly store: EPUBDocStore,
    public readonly pubURL: string
  ) {
    this.documentURLTransformer = this.createDocumentURLTransformer();
    checkMathJax();
  }

  createDocumentURLTransformer() {
    const self = this;

    class OPFDocumentURLTransformer implements Base.DocumentURLTransformer {
      /**
       * @override
       */
      transformFragment(fragment: string, baseURL: string): string {
        const url = baseURL + (fragment ? `#${fragment}` : "");
        return transformedIdPrefix + Base.escapeNameStrToHex(url, ":");
      }

      /**
       * @override
       */
      transformURL(url: string, baseURL: string): string {
        const r = url.match(/^([^#]*)#?(.*)$/);
        if (r) {
          const path = r[1] || baseURL;
          const fragment = r[2];
          if (path) {
            if (self.items.some(item => item.src === path)) {
              return `#${this.transformFragment(fragment, path)}`;
            }
          }
        }
        return url;
      }

      /**
       * @override
       */
      restoreURL(encoded: string): string[] {
        if (encoded.charAt(0) === "#") {
          encoded = encoded.substring(1);
        }
        if (encoded.indexOf(transformedIdPrefix) === 0) {
          encoded = encoded.substring(transformedIdPrefix.length);
        }
        const decoded = Base.unescapeStrFromHex(encoded, ":");
        const r = decoded.match(/^([^#]*)#?(.*)$/);
        return r ? [r[1], r[2]] : [];
      }
    }
    return new OPFDocumentURLTransformer();
  }

  /**
   * Metadata is organized in the following way: fully-expanded property names
   * (with IRI prefixes prepended) point to an array of values. Array contains
   * at least one element. First element is primary and should be used by
   * default. Element values are objects have the following keys:
   * - "v" - item value as string,
   * - "s" - scheme,
   * - "o" - index in the order of appearing in the source,
   * - "r" - refinement submetadata (organized just like the top-level
   * metadata).
   */
  getMetadata(): Base.JSON {
    return this.metadata;
  }

  getPathFromURL(url: string): string | null {
    if (url.startsWith("data:")) {
      return url === this.pubURL ? "" : url;
    }
    if (this.pubURL) {
      let epubBaseURL = Base.resolveURL("", this.pubURL);
      if (url === epubBaseURL || url + "/" === epubBaseURL) {
        return "";
      }
      if (epubBaseURL.charAt(epubBaseURL.length - 1) != "/") {
        epubBaseURL += "/";
      }
      return url.substr(0, epubBaseURL.length) == epubBaseURL
        ? decodeURI(url.substr(epubBaseURL.length))
        : null;
    } else {
      return url;
    }
  }

  initWithXMLDoc(
    opfXML: XmlDoc.XMLDocHolder,
    encXML: XmlDoc.XMLDocHolder,
    zipMetadata: Base.JSON,
    manifestURL: string
  ): Task.Result<any> {
    const self = this;
    this.opfXML = opfXML;
    this.encXML = encXML;
    const pkg = opfXML.doc().child("package");
    const uidref = pkg.attribute("unique-identifier")[0];
    if (uidref) {
      const uidElem = opfXML.getElement(`${opfXML.url}#${uidref}`);
      if (uidElem) {
        this.uid = uidElem.textContent.replace(/[ \n\r\t]/g, "");
      }
    }
    const srcToFallbackId = {};
    this.items = pkg
      .child("manifest")
      .child("item")
      .asArray()
      .map(node => {
        const item = new OPFItem();
        const elem = node as Element;
        item.initWithElement(elem, opfXML.url);
        const fallback = elem.getAttribute("fallback");
        if (fallback && !supportedMediaTypes[item.mediaType]) {
          srcToFallbackId[item.src] = fallback;
        }
        if (!self.xhtmlToc && item.itemProperties["nav"]) {
          self.xhtmlToc = item;
        }
        if (!self.cover && item.itemProperties["cover-image"]) {
          self.cover = item;
        }
        return item;
      });
    this.itemMap = Base.indexArray(this.items, getOPFItemId as (
      p1: OPFItem
    ) => string | null);
    this.itemMapByPath = Base.indexArray(this.items, item =>
      self.getPathFromURL(item.src)
    );
    for (const src in srcToFallbackId) {
      let fallbackSrc = src;
      while (true) {
        const item = this.itemMap[srcToFallbackId[fallbackSrc]];
        if (!item) {
          break;
        }
        if (supportedMediaTypes[item.mediaType]) {
          this.fallbackMap[src] = item.src;
          break;
        }
        fallbackSrc = item.src;
      }
    }
    this.spine = pkg
      .child("spine")
      .child("itemref")
      .asArray()
      .map((node, index) => {
        const elem = node as Element;
        const id = elem.getAttribute("idref");
        const item = self.itemMap[id as string];
        if (item) {
          item.itemRefElement = elem;
          item.spineIndex = index;
        }
        return item;
      });
    const tocAttr = pkg.child("spine").attribute("toc")[0];
    if (tocAttr) {
      this.ncxToc = this.itemMap[tocAttr];
    }
    const pageProgressionAttr = pkg
      .child("spine")
      .attribute("page-progression-direction")[0];
    if (pageProgressionAttr) {
      this.pageProgression = Constants.pageProgressionOf(pageProgressionAttr);
    }
    const idpfObfURLs = !encXML
      ? []
      : encXML
          .doc()
          .child("encryption")
          .child("EncryptedData")
          .predicate(
            XmlDoc.predicate.withChild(
              "EncryptionMethod",
              XmlDoc.predicate.withAttribute(
                "Algorithm",
                "http://www.idpf.org/2008/embedding"
              )
            )
          )
          .child("CipherData")
          .child("CipherReference")
          .attribute("URI");
    const mediaTypeElems = pkg
      .child("bindings")
      .child("mediaType")
      .asArray() as Element[];
    for (let i = 0; i < mediaTypeElems.length; i++) {
      const handlerId = mediaTypeElems[i].getAttribute("handler");
      const mediaType = mediaTypeElems[i].getAttribute("media-type");
      if (mediaType && handlerId && this.itemMap[handlerId]) {
        this.bindings[mediaType] = this.itemMap[handlerId].src;
      }
    }
    this.metadata = readMetadata(
      pkg.child("metadata"),
      pkg.attribute("prefix")[0]
    );
    if (this.metadata[metaTerms.language]) {
      this.lang = this.metadata[metaTerms.language][0]["v"];
    }
    if (this.metadata[metaTerms.layout]) {
      this.prePaginated =
        this.metadata[metaTerms.layout][0]["v"] === "pre-paginated";
    }

    if (!zipMetadata) {
      if (idpfObfURLs.length > 0 && this.uid) {
        // Have to deobfuscate in JavaScript
        const deobfuscator = makeDeobfuscator(this.uid);
        for (let i = 0; i < idpfObfURLs.length; i++) {
          this.store.deobfuscators[this.pubURL + idpfObfURLs[i]] = deobfuscator;
        }
      }
      if (this.prePaginated) {
        this.assignAutoPages();
      }
      return Task.newResult(true);
    }
    const manifestText = new Base.StringBuffer();
    const obfuscations = {};
    if (idpfObfURLs.length > 0 && this.uid) {
      // Deobfuscate in the server.
      const obfuscationKey = makeObfuscationKey(this.uid);
      for (let i = 0; i < idpfObfURLs.length; i++) {
        obfuscations[idpfObfURLs[i]] = obfuscationKey;
      }
    }
    for (let i = 0; i < zipMetadata.length; i++) {
      const entry = zipMetadata[i];
      const encodedPath = entry["n"];
      if (encodedPath) {
        const path = decodeURI(encodedPath);
        const item = this.itemMapByPath[path];
        let mediaType = null;
        if (item) {
          item.compressed = entry["m"] != 0;
          item.compressedSize = entry["c"];
          if (item.mediaType) {
            mediaType = item.mediaType.replace(/\s+/g, "");
          }
        }
        const obfuscation = obfuscations[path];
        if (mediaType || obfuscation) {
          manifestText.append(encodedPath);
          manifestText.append(" ");
          manifestText.append(mediaType || "application/octet-stream");
          if (obfuscation) {
            manifestText.append(" ");
            manifestText.append(obfuscation);
          }
          manifestText.append("\n");
        }
      }
    }
    self.assignAutoPages();
    return Net.ajax(
      manifestURL,
      Net.XMLHttpRequestResponseType.DEFAULT,
      "POST",
      manifestText.toString(),
      "text/plain"
    );
  }

  assignAutoPages(): void {
    let epage = 0;
    for (const item of this.spine) {
      const epageCount = this.prePaginated
        ? 1
        : Math.ceil(item.compressedSize / 1024);
      item.epage = epage;
      item.epageCount = epageCount;
      epage += epageCount;
    }
    this.epageCount = epage;

    if (this.epageCountCallback) {
      this.epageCountCallback(this.epageCount);
    }
  }

  setEPageCountMode(epageIsRenderedPage: boolean) {
    this.epageIsRenderedPage = epageIsRenderedPage || this.prePaginated;
  }

  countEPages(
    epageCountCallback: ((p1: number) => void) | null
  ): Task.Result<boolean> {
    this.epageCountCallback = epageCountCallback;

    if (this.epageIsRenderedPage) {
      if (this.prePaginated && this.epageCount == 0) {
        this.assignAutoPages();
      }
      return Task.newResult(true);
    }

    let epage = 0;
    let i = 0;
    const frame: Task.Frame<boolean> = Task.newFrame("countEPages");
    frame
      .loopWithFrame(loopFrame => {
        if (i === this.spine.length) {
          loopFrame.breakLoop();
          return;
        }
        const item = this.spine[i++];
        item.epage = epage;
        this.store.load(item.src).then(xmldoc => {
          // According to the old comment,
          // "Estimate that offset=2700 roughly corresponds to 1024 bytes of compressed size."
          // However, it should depend on the language.
          // Further adjustment needed.

          //let offsetPerEPage = 2700;
          let offsetPerEPage = 1800;
          const lang = xmldoc.lang || this.lang;
          if (lang && lang.match(/^(ja|ko|zh)/)) {
            offsetPerEPage /= 3;
          }
          item.epageCount = Math.ceil(xmldoc.getTotalOffset() / offsetPerEPage);
          epage += item.epageCount;
          this.epageCount = epage;
          if (this.epageCountCallback) {
            this.epageCountCallback(this.epageCount);
          }
          loopFrame.continueLoop();
        });
      })
      .thenFinish(frame);
    return frame.result();
  }

  /**
   * Creates a fake OPF "document" that contains OPS chapters.
   */
  initWithChapters(params: OPFItemParam[], doc?: Document | null) {
    this.itemMap = {};
    this.itemMapByPath = {};
    this.items = [];
    this.spine = this.items;

    // create a minimum fake OPF XML for navigation with EPUB CFI
    const opfXML = (this.opfXML = new XmlDoc.XMLDocHolder(
      null,
      "",
      new DOMParser().parseFromString("<spine></spine>", "text/xml")
    ));
    params.forEach(param => {
      const item = new OPFItem();
      item.initWithParam(param);
      Asserts.assert(item.id);
      const itemref = opfXML.document.createElement("itemref");
      itemref.setAttribute("idref", item.id);
      opfXML.root.appendChild(itemref);
      item.itemRefElement = itemref;
      this.itemMap[item.id] = item;
      let path = this.getPathFromURL(param.url);
      if (path == null) {
        path = param.url;
      }
      this.itemMapByPath[path] = item;
      this.items.push(item);
    });
    if (doc) {
      return this.store.addDocument(params[0].url, doc);
    } else {
      return Task.newResult(null);
    }
  }

  initWithWebPubManifest(
    manifestObj: Base.JSON,
    doc?: Document
  ): Task.Result<boolean> {
    if (manifestObj["readingProgression"]) {
      this.pageProgression = manifestObj["readingProgression"];
    }
    if (this.metadata === undefined) {
      this.metadata = {};
    }
    const title =
      (doc && doc.title) ||
      manifestObj["name"] ||
      (manifestObj["metadata"] && manifestObj["metadata"]["title"]);
    if (title) {
      this.metadata[metaTerms.title] = [{ v: title }];
    }
    // TODO: other metadata...

    const primaryEntryPath = this.getPathFromURL(this.pubURL);
    if (!manifestObj["readingOrder"] && doc && primaryEntryPath !== null) {
      manifestObj["readingOrder"] = [encodeURI(primaryEntryPath)];

      // Find TOC in the primary entry (X)HTML
      const selector =
        "[role=doc-toc] a[href]," +
        "[role=directory] a[href]," +
        "nav li a[href]," +
        ".toc a[href]," +
        "#toc a[href]";
      Array.from(doc.querySelectorAll(selector)).forEach(anchorElem => {
        const hrefNoFragment = Base.stripFragment(
          (anchorElem as any).href || anchorElem.getAttribute("href")
        );
        const path = this.getPathFromURL(hrefNoFragment);
        const url = path !== null ? encodeURI(path) : hrefNoFragment;
        if (manifestObj["readingOrder"].indexOf(url) == -1) {
          manifestObj["readingOrder"].push(url);
        }
      });
    }

    const params = [];
    let itemCount = 0;
    let tocFound = -1;
    [manifestObj["readingOrder"], manifestObj["resources"]].forEach(
      readingOrderOrResources => {
        if (readingOrderOrResources instanceof Array) {
          readingOrderOrResources.forEach(itemObj => {
            const isInReadingOrder = manifestObj["readingOrder"].includes(
              itemObj
            );
            const url =
              typeof itemObj === "string"
                ? itemObj
                : itemObj.url || itemObj.href;
            const encodingFormat =
              typeof itemObj === "string"
                ? ""
                : itemObj.encodingFormat ||
                  (itemObj.href && itemObj.type) ||
                  "";
            if (
              isInReadingOrder ||
              encodingFormat === "text/html" ||
              encodingFormat === "application/xhtml+xml" ||
              /(^|\/)([^/]+\.(x?html|htm|xht)|[^/.]*)([#?]|$)/.test(url)
            ) {
              const param = {
                url: Base.resolveURL(Base.convertSpecialURL(url), this.pubURL),
                index: itemCount++,
                startPage: null,
                skipPagesBefore: null
              };
              if (itemObj.rel === "contents" && tocFound === -1) {
                tocFound = param.index;
              }
              params.push(param);

              //TODO: items not in readingOrder should be excluded from linear reading but available with internal link navigation.
            }
          });
        }
      }
    );
    const frame: Task.Frame<boolean> = Task.newFrame("initWithWebPubManifest");
    this.initWithChapters(params).then(() => {
      if (tocFound !== -1) {
        this.xhtmlToc = this.items[tocFound];
      }

      if (!this.xhtmlToc) {
        this.xhtmlToc = this.itemMapByPath[primaryEntryPath];
      }

      frame.finish(true);
    });
    return frame.result();
  }

  /**
   * @return cfi
   */
  getCFI(spineIndex: number, offsetInItem: number): Task.Result<string | null> {
    const item = this.spine[spineIndex];
    const frame: Task.Frame<string | null> = Task.newFrame("getCFI");
    this.store.load(item.src).then((xmldoc: XmlDoc.XMLDocHolder) => {
      const node = xmldoc.getNodeByOffset(offsetInItem);
      let cfi = null;
      if (node) {
        const startOffset = xmldoc.getNodeOffset(node, 0, false);
        const offsetInNode = offsetInItem - startOffset;
        const fragment = new Cfi.Fragment();
        fragment.prependPathFromNode(node, offsetInNode, false, null);
        if (item.itemRefElement) {
          fragment.prependPathFromNode(item.itemRefElement, 0, false, null);
        }
        cfi = fragment.toString();
      }
      frame.finish(cfi);
    });
    return frame.result();
  }

  resolveFragment(fragstr: string | null): Task.Result<Position | null> {
    const self = this;
    return Task.handle(
      "resolveFragment",
      (frame: Task.Frame<Position | null>): void => {
        if (!fragstr) {
          frame.finish(null);
          return;
        }
        let fragment = new Cfi.Fragment();
        fragment.fromString(fragstr);
        let item;
        if (self.opfXML) {
          const opfNav = fragment.navigate(self.opfXML.document);
          if (opfNav.node.nodeType != 1 || opfNav.after || !opfNav.ref) {
            frame.finish(null);
            return;
          }
          const elem = opfNav.node as Element;
          const idref = elem.getAttribute("idref");
          if (elem.localName != "itemref" || !idref || !self.itemMap[idref]) {
            frame.finish(null);
            return;
          }
          item = self.itemMap[idref];
          fragment = opfNav.ref;
        } else {
          item = self.spine[0];
        }
        self.store.load(item.src).then((xmldoc: XmlDoc.XMLDocHolder) => {
          const nodeNav = fragment.navigate(xmldoc.document);
          const offset = xmldoc.getNodeOffset(
            nodeNav.node,
            nodeNav.offset,
            nodeNav.after
          );
          frame.finish({
            spineIndex: item.spineIndex,
            offsetInItem: offset,
            pageIndex: -1
          });
        });
      },
      (frame: Task.Frame<Position | null>, err: Error): void => {
        Logging.logger.warn(err, "Cannot resolve fragment:", fragstr);
        frame.finish(null);
      }
    );
  }

  resolveEPage(epage: number): Task.Result<Position | null> {
    const self = this;
    return Task.handle(
      "resolveEPage",
      (frame: Task.Frame<Position | null>): void => {
        if (epage <= 0) {
          frame.finish({ spineIndex: 0, offsetInItem: 0, pageIndex: -1 });
          return;
        }
        if (self.epageIsRenderedPage) {
          let spineIndex = self.spine.findIndex(item => {
            return (
              (item.epage == 0 && item.epageCount == 0) ||
              (item.epage <= epage && item.epage + item.epageCount > epage)
            );
          });
          if (spineIndex == -1) {
            spineIndex = self.spine.length - 1;
          }
          let item = self.spine[spineIndex];
          if (!item || item.epageCount == 0) {
            item = self.spine[--spineIndex];
          }
          const pageIndex = Math.floor(epage - item.epage);
          frame.finish({ spineIndex, offsetInItem: -1, pageIndex: pageIndex });
          return;
        }
        let spineIndex = Base.binarySearch(self.spine.length, index => {
          const item = self.spine[index];
          return item.epage + item.epageCount > epage;
        });
        if (spineIndex == self.spine.length) {
          spineIndex--;
        }
        const item = self.spine[spineIndex];
        self.store.load(item.src).then((xmldoc: XmlDoc.XMLDocHolder) => {
          epage -= item.epage;
          if (epage > item.epageCount) {
            epage = item.epageCount;
          }
          let offset = 0;
          if (epage > 0) {
            const totalOffset = xmldoc.getTotalOffset();
            offset = Math.round((totalOffset * epage) / item.epageCount);
            if (offset == totalOffset) {
              offset--;
            }
          }
          frame.finish({ spineIndex, offsetInItem: offset, pageIndex: -1 });
        });
      },
      (frame: Task.Frame<Position | null>, err: Error): void => {
        Logging.logger.warn(err, "Cannot resolve epage:", epage);
        frame.finish(null);
      }
    );
  }

  getEPageFromPosition(position: Position): Task.Result<number> {
    const item = this.spine[position.spineIndex];
    if (this.epageIsRenderedPage) {
      const epage = item.epage + position.pageIndex;
      return Task.newResult(epage);
    }
    if (position.offsetInItem <= 0) {
      return Task.newResult(item.epage);
    }
    const frame: Task.Frame<number> = Task.newFrame("getEPage");
    this.store.load(item.src).then((xmldoc: XmlDoc.XMLDocHolder) => {
      const totalOffset = xmldoc.getTotalOffset();
      const offset = Math.min(totalOffset, position.offsetInItem);
      frame.finish(item.epage + (offset * item.epageCount) / totalOffset);
    });
    return frame.result();
  }
}

export type PageAndPosition = {
  page: Vtree.Page;
  position: Position;
};

export const makePageAndPosition = (
  page: Vtree.Page,
  pageIndex: number
): PageAndPosition => ({
  page,
  position: {
    spineIndex: page.spineIndex,
    pageIndex,
    offsetInItem: page.offset
  }
});

export type OPFViewItem = {
  item: OPFItem;
  xmldoc: XmlDoc.XMLDocHolder;
  instance: Ops.StyleInstance;
  layoutPositions: Vtree.LayoutPosition[];
  pages: Vtree.Page[];
  complete: boolean;
};

export class OPFView implements Vgen.CustomRendererFactory {
  spineItems: OPFViewItem[] = [];
  spineItemLoadingContinuations: Task.Continuation<any>[][] = [];
  pref: Exprs.Preferences;
  clientLayout: Vgen.DefaultClientLayout;
  counterStore: Counters.CounterStore;
  tocAutohide: boolean = false;
  tocView?: Toc.TOCView;

  constructor(
    public readonly opf: OPFDoc,
    public readonly viewport: Vgen.Viewport,
    public readonly fontMapper: Font.Mapper,
    pref: Exprs.Preferences,
    public readonly pageSheetSizeReporter: (
      p1: { width: number; height: number },
      p2: { [key: string]: { width: number; height: number } },
      p3: number,
      p4: number
    ) => any
  ) {
    this.pref = Exprs.clonePreferences(pref);
    this.clientLayout = new Vgen.DefaultClientLayout(viewport);
    this.counterStore = new Counters.CounterStore(opf.documentURLTransformer);
  }

  private getPage(position: Position): Vtree.Page {
    const viewItem = this.spineItems[position.spineIndex];
    return viewItem ? viewItem.pages[position.pageIndex] : null;
  }

  getCurrentPageProgression(
    position: Position
  ): Constants.PageProgression | null {
    if (this.opf.pageProgression) {
      return this.opf.pageProgression;
    } else {
      const viewItem = this.spineItems[position ? position.spineIndex : 0];
      return viewItem ? viewItem.instance.pageProgression : null;
    }
  }

  private finishPageContainer(
    viewItem: OPFViewItem,
    page: Vtree.Page,
    pageIndex: number
  ) {
    page.container.style.display = "none";
    page.container.style.visibility = "visible";
    page.container.style.position = "";
    page.container.style.top = "";
    page.container.style.left = "";
    page.container.setAttribute(
      "data-vivliostyle-page-side",
      page.side as string
    );
    const oldPage = viewItem.pages[pageIndex];
    page.isFirstPage = viewItem.item.spineIndex == 0 && pageIndex == 0;
    viewItem.pages[pageIndex] = page;

    if (this.opf.epageIsRenderedPage) {
      if (pageIndex == 0 && viewItem.item.spineIndex > 0) {
        const prevItem = this.opf.spine[viewItem.item.spineIndex - 1];
        viewItem.item.epage = prevItem.epage + prevItem.epageCount;
      }
      viewItem.item.epageCount = viewItem.pages.length;
      this.opf.epageCount = this.opf.spine.reduce(
        (count, item) => count + item.epageCount,
        0
      );

      if (this.opf.epageCountCallback) {
        this.opf.epageCountCallback(this.opf.epageCount);
      }
    }

    if (oldPage) {
      viewItem.instance.viewport.contentContainer.replaceChild(
        page.container,
        oldPage.container
      );
      oldPage.dispatchEvent({
        type: "replaced",
        target: null,
        currentTarget: null,
        preventDefault: null,
        newPage: page
      });
    } else {
      // Find insert position in contentContainer.
      let insertPos = null;
      if (pageIndex > 0) {
        insertPos = viewItem.pages[pageIndex - 1].container.nextElementSibling;
      } else {
        for (
          let i = viewItem.item.spineIndex + 1;
          i < this.spineItems.length;
          i++
        ) {
          const item = this.spineItems[i];
          if (item && item.pages[0]) {
            insertPos = item.pages[0].container;
            break;
          }
        }
      }
      viewItem.instance.viewport.contentContainer.insertBefore(
        page.container,
        insertPos
      );
    }
    this.pageSheetSizeReporter(
      {
        width: viewItem.instance.pageSheetWidth,
        height: viewItem.instance.pageSheetHeight
      },
      viewItem.instance.pageSheetSize,
      viewItem.item.spineIndex,
      viewItem.instance.pageNumberOffset + pageIndex
    );
  }

  /**
   * Render a single page. If the new page contains elements with ids that are
   * referenced from other pages by 'target-counter()', those pages are rendered
   * too (calling `renderSinglePage` recursively).
   */
  private renderSinglePage(
    viewItem: OPFViewItem,
    pos: Vtree.LayoutPosition
  ): Task.Result<RenderSinglePageResult> {
    const frame: Task.Frame<RenderSinglePageResult> = Task.newFrame(
      "renderSinglePage"
    );
    let page = this.makePage(viewItem, pos);
    const self = this;
    viewItem.instance.layoutNextPage(page, pos).then(posParam => {
      pos = posParam as Vtree.LayoutPosition;
      const pageIndex = pos
        ? pos.page - 1
        : viewItem.layoutPositions.length - 1;
      self.finishPageContainer(viewItem, page, pageIndex);
      self.counterStore.finishPage(page.spineIndex, pageIndex);

      // If the position of the page break change, we should re-layout the next
      // page too.
      let cont = null;
      if (pos) {
        const prevPos = viewItem.layoutPositions[pos.page];
        viewItem.layoutPositions[pos.page] = pos;
        if (prevPos && viewItem.pages[pos.page]) {
          if (!pos.isSamePosition(prevPos)) {
            cont = self.renderSinglePage(viewItem, pos);
          }
        }
      }
      if (!cont) {
        cont = Task.newResult(true);
      }
      cont.then(() => {
        const unresolvedRefs = self.counterStore.getUnresolvedRefsToPage(page);
        let index = 0;
        frame
          .loopWithFrame(loopFrame => {
            index++;
            if (index > unresolvedRefs.length) {
              loopFrame.breakLoop();
              return;
            }
            const refs = unresolvedRefs[index - 1];
            refs.refs = refs.refs.filter(ref => !ref.isResolved());
            if (refs.refs.length === 0) {
              loopFrame.continueLoop();
              return;
            }
            self.getPageViewItem(refs.spineIndex).then(viewItem => {
              if (!viewItem) {
                loopFrame.continueLoop();
                return;
              }
              self.counterStore.pushPageCounters(refs.pageCounters);
              self.counterStore.pushReferencesToSolve(refs.refs);
              const pos = viewItem.layoutPositions[refs.pageIndex];
              self.renderSinglePage(viewItem, pos).then(result => {
                self.counterStore.popPageCounters();
                self.counterStore.popReferencesToSolve();
                const resultPosition = result.pageAndPosition.position;
                if (
                  resultPosition.spineIndex === page.spineIndex &&
                  resultPosition.pageIndex === pageIndex
                ) {
                  page = result.pageAndPosition.page;
                }
                loopFrame.continueLoop();
              });
            });
          })
          .then(() => {
            if (!page.container.parentElement) {
              // page is replaced
              page = viewItem.pages[pageIndex];
            }
            page.isLastPage =
              !pos && viewItem.item.spineIndex === self.opf.spine.length - 1;
            if (page.isLastPage) {
              Asserts.assert(self.viewport);
              self.counterStore.finishLastPage(self.viewport);
            }
            frame.finish({
              pageAndPosition: makePageAndPosition(page, pageIndex),
              nextLayoutPosition: pos
            });
          });
      });
    });
    return frame.result();
  }

  private normalizeSeekPosition(
    position: Position,
    viewItem: OPFViewItem
  ): Position | null {
    let pageIndex = position.pageIndex;
    let seekOffset = -1;
    if (pageIndex < 0) {
      seekOffset = position.offsetInItem;

      // page with offset higher than seekOffset
      const seekOffsetPageIndex = Base.binarySearch(
        viewItem.layoutPositions.length,
        pageIndex => {
          // 'noLookAhead' argument of getPosition must be true, since
          // otherwise StyleInstance.currentLayoutPosition is modified
          // unintentionally.
          const offset = viewItem.instance.getPosition(
            viewItem.layoutPositions[pageIndex],
            true
          );
          return offset > seekOffset;
        }
      );
      if (seekOffsetPageIndex === viewItem.layoutPositions.length) {
        if (viewItem.complete) {
          pageIndex = viewItem.layoutPositions.length - 1;
        } else {
          // need to search through pages that are not yet produced
          pageIndex = Number.POSITIVE_INFINITY;
        }
      } else {
        // page that contains seekOffset
        pageIndex = seekOffsetPageIndex - 1;
      }
    } else if (
      pageIndex === Number.POSITIVE_INFINITY &&
      position.offsetInItem !== -1
    ) {
      seekOffset = position.offsetInItem;
    }
    return {
      spineIndex: position.spineIndex,
      pageIndex,
      offsetInItem: seekOffset
    } as Position;
  }

  /**
   * Find a page corresponding to a specified position among already laid out
   * pages.
   * @param sync If true, find the page synchronously (not waiting another
   *     rendering task)
   */
  private findPage(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const self = this;
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame("findPage");
    self.getPageViewItem(position.spineIndex).then(viewItem => {
      if (!viewItem) {
        frame.finish(null);
        return;
      }
      let resultPage = null;
      let pageIndex;
      frame
        .loopWithFrame(loopFrame => {
          const normalizedPosition = self.normalizeSeekPosition(
            position,
            viewItem
          );
          pageIndex = normalizedPosition.pageIndex;
          resultPage = viewItem.pages[pageIndex];
          if (resultPage) {
            loopFrame.breakLoop();
          } else if (viewItem.complete) {
            pageIndex = viewItem.layoutPositions.length - 1;
            resultPage = viewItem.pages[pageIndex];
            loopFrame.breakLoop();
          } else if (sync) {
            self.renderPage(normalizedPosition).then(result => {
              if (result) {
                resultPage = result.page;
                pageIndex = result.position.pageIndex;
              }
              loopFrame.breakLoop();
            });
          } else {
            // Wait for the layout task and retry
            frame.sleep(100).then(() => {
              loopFrame.continueLoop();
            });
          }
        })
        .then(() => {
          Asserts.assert(resultPage);
          frame.finish(makePageAndPosition(resultPage, pageIndex));
        });
    });
    return frame.result();
  }

  /**
   * Renders a page at the specified position.
   */
  renderPage(position: Position): Task.Result<PageAndPosition | null> {
    const self = this;
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame(
      "renderPage"
    );
    self.getPageViewItem(position.spineIndex).then(viewItem => {
      if (!viewItem) {
        frame.finish(null);
        return;
      }
      const normalizedPosition = self.normalizeSeekPosition(position, viewItem);
      let pageIndex = normalizedPosition.pageIndex;
      const seekOffset = normalizedPosition.offsetInItem;
      let resultPage = viewItem.pages[pageIndex];
      if (resultPage) {
        frame.finish(makePageAndPosition(resultPage, pageIndex));
        return;
      }
      frame
        .loopWithFrame(loopFrame => {
          if (pageIndex < viewItem.layoutPositions.length) {
            loopFrame.breakLoop();
            return;
          }
          if (viewItem.complete) {
            pageIndex = viewItem.layoutPositions.length - 1;
            loopFrame.breakLoop();
            return;
          }
          let pos =
            viewItem.layoutPositions[viewItem.layoutPositions.length - 1];
          self.renderSinglePage(viewItem, pos).then(result => {
            const page = result.pageAndPosition.page;
            pos = result.nextLayoutPosition;
            if (pos) {
              if (seekOffset >= 0) {
                // Searching for offset, don't know the page number.
                const offset = viewItem.instance.getPosition(pos);
                if (offset > seekOffset) {
                  resultPage = page;
                  pageIndex = viewItem.layoutPositions.length - 2;
                  loopFrame.breakLoop();
                  return;
                }
              }
              loopFrame.continueLoop();
            } else {
              resultPage = page;
              pageIndex = result.pageAndPosition.position.pageIndex;
              viewItem.complete = true;
              loopFrame.breakLoop();
            }
          });
        })
        .then(() => {
          resultPage = resultPage || viewItem.pages[pageIndex];
          const pos = viewItem.layoutPositions[pageIndex];
          if (resultPage) {
            frame.finish(makePageAndPosition(resultPage, pageIndex));
            return;
          }
          self.renderSinglePage(viewItem, pos).then(result => {
            if (!result.nextLayoutPosition) {
              viewItem.complete = true;
            }
            frame.finish(result.pageAndPosition);
          });
        });
    });
    return frame.result();
  }

  renderAllPages(): Task.Result<PageAndPosition | null> {
    return this.renderPagesUpto(
      {
        spineIndex: this.opf.spine.length - 1,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1
      },
      false
    );
  }

  /**
   * Render pages from (spineIndex=0, pageIndex=0) to the specified (spineIndex,
   * pageIndex).
   * @param notAllPages If true, render from biginning of specified spine item.
   */
  renderPagesUpto(
    position: Position,
    notAllPages: boolean
  ): Task.Result<PageAndPosition | null> {
    const self = this;
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame(
      "renderPagesUpto"
    );
    if (!position) {
      position = { spineIndex: 0, pageIndex: 0, offsetInItem: 0 };
    }
    const spineIndex = position.spineIndex;
    const pageIndex = position.pageIndex;
    let s = 0;

    if (notAllPages) {
      // Render pages from biginning of specified spine item.
      s = spineIndex;
    }

    let lastResult;
    frame
      .loopWithFrame(loopFrame => {
        const pos = {
          spineIndex: s,
          pageIndex: s === spineIndex ? pageIndex : Number.POSITIVE_INFINITY,
          offsetInItem: s === spineIndex ? position.offsetInItem : -1
        };
        self.renderPage(pos).then(result => {
          lastResult = result;
          if (++s > spineIndex) {
            loopFrame.breakLoop();
          } else {
            loopFrame.continueLoop();
          }
        });
      })
      .then(() => {
        frame.finish(lastResult);
      });
    return frame.result();
  }

  /**
   * Move to the first page and render it.
   */
  firstPage(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    return this.findPage(
      { spineIndex: 0, pageIndex: 0, offsetInItem: -1 },
      sync
    );
  }

  /**
   * Move to the last page and render it.
   */
  lastPage(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    return this.findPage(
      {
        spineIndex: this.opf.spine.length - 1,
        pageIndex: Number.POSITIVE_INFINITY,
        offsetInItem: -1
      },
      sync
    );
  }

  /**
   * Move to the next page position and render page.
   * @param sync If true, get the page synchronously (not waiting another
   *     rendering task)
   */
  nextPage(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const self = this;
    let spineIndex = position.spineIndex;
    let pageIndex = position.pageIndex;
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame("nextPage");
    self.getPageViewItem(spineIndex).then(viewItem => {
      if (!viewItem) {
        frame.finish(null);
        return;
      }
      if (
        viewItem.complete &&
        pageIndex == viewItem.layoutPositions.length - 1
      ) {
        if (spineIndex >= self.opf.spine.length - 1) {
          frame.finish(null);
          return;
        }
        spineIndex++;
        pageIndex = 0;

        // Remove next viewItem if its first page has same side as the current page
        // to avoid unpaired page.
        const nextViewItem = this.spineItems[spineIndex];
        const nextPage = nextViewItem && nextViewItem.pages[0];
        const currentPage = viewItem.pages[viewItem.pages.length - 1];
        if (nextPage && currentPage && nextPage.side == currentPage.side) {
          nextViewItem.pages.forEach(page => {
            if (page.container) page.container.remove();
          });
          this.spineItems[spineIndex] = null;
          this.spineItemLoadingContinuations[spineIndex] = null;
        }
      } else {
        pageIndex++;
      }
      self
        .findPage({ spineIndex, pageIndex, offsetInItem: -1 }, sync)
        .thenFinish(frame);
    });
    return frame.result();
  }

  /**
   * Move to the previous page and render it.
   */
  previousPage(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    let spineIndex = position.spineIndex;
    let pageIndex = position.pageIndex;
    if (pageIndex == 0) {
      if (spineIndex == 0) {
        return Task.newResult(null as PageAndPosition | null);
      }
      spineIndex--;
      pageIndex = Number.POSITIVE_INFINITY;
    } else {
      pageIndex--;
    }
    return this.findPage({ spineIndex, pageIndex, offsetInItem: -1 }, sync);
  }

  /**
   * @param page This page should be a currently displayed page.
   */
  private isRectoPage(page: Vtree.Page, position: Position): boolean {
    const isLeft = page.side === Constants.PageSide.LEFT;
    const isLTR =
      this.getCurrentPageProgression(position) ===
      Constants.PageProgression.LTR;
    return (!isLeft && isLTR) || (isLeft && !isLTR);
  }

  /**
   * Get a spread containing the currently displayed page.
   * @param sync If true, get the spread synchronously (not waiting another
   *     rendering task)
   */
  getSpread(position: Position, sync: boolean): Task.Result<Vtree.Spread> {
    const frame: Task.Frame<Vtree.Spread> = Task.newFrame("getCurrentSpread");
    const page = this.getPage(position);
    if (!page) {
      return Task.newResult(
        /** @type Vtree.Spread */
        { left: null, right: null } as Vtree.Spread
      );
    }
    const isLeft = page.side === Constants.PageSide.LEFT;
    let other;
    if (this.isRectoPage(page, position)) {
      other = this.previousPage(position, sync);
    } else {
      other = this.nextPage(position, sync);
    }
    other.then(otherPageAndPosition => {
      // this page may be replaced during nextPage(), so get thisPage again.
      const thisPage = this.getPage(position);

      let otherPage = otherPageAndPosition && otherPageAndPosition.page;
      if (otherPage && otherPage.side === thisPage.side) {
        // otherPage must not be same side
        otherPage = null;
      }

      if (isLeft) {
        frame.finish({ left: thisPage, right: otherPage });
      } else {
        frame.finish({ left: otherPage, right: thisPage });
      }
    });
    return frame.result();
  }

  /**
   * Move to the next spread and render pages.
   * @param sync If true, get the spread synchronously (not waiting another
   *     rendering task)
   * @returns The 'verso' page of the next spread.
   */
  nextSpread(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const page = this.getPage(position);
    if (!page) {
      return Task.newResult(null as PageAndPosition | null);
    }
    const isRecto = this.isRectoPage(page, position);
    const next = this.nextPage(position, sync);
    if (isRecto) {
      return next;
    } else {
      const self = this;
      return next.thenAsync(result => {
        if (result) {
          if (result.page.side === page.side) {
            // If same side, this is the next spread.
            return next;
          }
          const next2 = self.nextPage(result.position, sync);
          return next2.thenAsync(result2 => {
            if (result2) {
              return next2;
            } else {
              // If this is tha last spread, move to next page in the same spread.
              return next;
            }
          });
        } else {
          return Task.newResult(null as PageAndPosition | null);
        }
      });
    }
  }

  /**
   * Move to the previous spread and render pages.
   * @returns The 'recto' page of the previous spread.
   */
  previousSpread(
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const page = this.getPage(position);
    if (!page) {
      return Task.newResult(null as PageAndPosition | null);
    }
    const isRecto = this.isRectoPage(page, position);
    const prev = this.previousPage(position, sync);
    const oldPrevPageCont = page.container.previousElementSibling;
    if (isRecto) {
      const self = this;
      return prev.thenAsync(result => {
        if (result) {
          if (result.page.side === page.side) {
            // If same side, this is the previous spread.
            return prev;
          }
          if (result.page.container !== oldPrevPageCont) {
            // If previous page is changed, return it.
            return prev;
          }
          return self.previousPage(result.position, sync);
        } else {
          return Task.newResult(null as PageAndPosition | null);
        }
      });
    } else {
      return prev;
    }
  }

  /**
   * Move to the epage specified by the given number (zero-based) and render it.
   */
  navigateToEPage(
    epage: number,
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame(
      "navigateToEPage"
    );
    const self = this;
    this.opf.resolveEPage(epage).then(position => {
      if (position) {
        self.findPage(position, sync).thenFinish(frame);
      } else {
        frame.finish(null);
      }
    });
    return frame.result();
  }

  /**
   * Move to the page specified by the given CFI and render it.
   */
  navigateToFragment(
    fragment: string,
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame(
      "navigateToCFI"
    );
    const self = this;
    self.opf.resolveFragment(fragment).then(position => {
      if (position) {
        self.findPage(position, sync).thenFinish(frame);
      } else {
        frame.finish(null);
      }
    });
    return frame.result();
  }

  /**
   * Move to the page specified by the given URL and render it.
   */
  navigateTo(
    href: string,
    position: Position,
    sync: boolean
  ): Task.Result<PageAndPosition | null> {
    Logging.logger.debug("Navigate to", href);
    let path = this.opf.getPathFromURL(Base.stripFragment(href));
    if (!path) {
      if (this.opf.opfXML && href.match(/^#epubcfi\(/)) {
        // CFI fragment is "relative" to OPF.
        path = this.opf.getPathFromURL(this.opf.opfXML.url);
      } else if (href.charAt(0) === "#") {
        const restored = this.opf.documentURLTransformer.restoreURL(href);
        if (this.opf.opfXML) {
          path = this.opf.getPathFromURL(restored[0]);
          if (path == null) {
            path = restored[0];
          }
        } else {
          path = restored[0];
        }
        href = path + (restored[1] ? `#${restored[1]}` : "");
      }
      if (path == null) {
        return Task.newResult(null as PageAndPosition | null);
      }
    }
    const item = this.opf.itemMapByPath[path];
    if (!item) {
      if (
        this.opf.opfXML &&
        path == this.opf.getPathFromURL(this.opf.opfXML.url)
      ) {
        // CFI link?
        const fragmentIndex = href.indexOf("#");
        if (fragmentIndex >= 0) {
          return this.navigateToFragment(
            href.substr(fragmentIndex + 1),
            position,
            sync
          );
        }
      }
      return Task.newResult(null as PageAndPosition | null);
    }
    const frame: Task.Frame<PageAndPosition | null> = Task.newFrame(
      "navigateTo"
    );
    const self = this;
    self.getPageViewItem(item.spineIndex).then(viewItem => {
      if (!viewItem) {
        frame.finish(null);
        return;
      }
      const target = viewItem.xmldoc.getElement(href);
      if (target) {
        self
          .findPage(
            {
              spineIndex: item.spineIndex,
              pageIndex: -1,
              offsetInItem: viewItem.xmldoc.getElementOffset(target)
            },
            sync
          )
          .thenFinish(frame);
      } else if (position.spineIndex !== item.spineIndex) {
        // no fragment, different spine item
        self
          .findPage(
            {
              spineIndex: item.spineIndex,
              pageIndex: 0,
              offsetInItem: -1
            },
            sync
          )
          .thenFinish(frame);
      } else {
        frame.finish(null);
      }
    });
    return frame.result();
  }

  makePage(viewItem: OPFViewItem, pos: Vtree.LayoutPosition): Vtree.Page {
    const viewport = viewItem.instance.viewport;
    const pageCont = viewport.document.createElement("div") as HTMLElement;
    pageCont.setAttribute("data-vivliostyle-page-container", "true");
    pageCont.setAttribute("role", "region");
    pageCont.style.position = "absolute";
    pageCont.style.top = "0";
    pageCont.style.left = "0";
    if (!Constants.isDebug) {
      pageCont.style.visibility = "hidden";
      pageCont.setAttribute("aria-hidden", "true");
    }
    viewport.layoutBox.appendChild(pageCont);
    const bleedBox = viewport.document.createElement("div") as HTMLElement;
    bleedBox.setAttribute("data-vivliostyle-bleed-box", "true");
    pageCont.appendChild(bleedBox);
    const page = new Vtree.Page(pageCont, bleedBox);
    page.spineIndex = viewItem.item.spineIndex;
    page.position = pos;
    page.offset = viewItem.instance.getPosition(pos);
    if (page.offset === 0) {
      const id = this.opf.documentURLTransformer.transformFragment(
        "",
        viewItem.item.src
      );
      bleedBox.setAttribute("id", id);
      page.registerElementWithId(bleedBox, id);
    }
    if (viewport !== this.viewport) {
      const matrix = Exprs.letterbox(
        this.viewport.width,
        this.viewport.height,
        viewport.width,
        viewport.height
      );
      const cssMatrix = CssParse.parseValue(
        null,
        new CssTok.Tokenizer(matrix, null),
        ""
      );
      page.delayedItems.push(
        new Vtree.DelayedItem(pageCont, "transform", cssMatrix)
      );
    }
    return page;
  }

  makeObjectView(
    xmldoc: XmlDoc.XMLDocHolder,
    srcElem: Element,
    viewParent: Element,
    computedStyle
  ): Task.Result<Element> {
    let data = srcElem.getAttribute("data");
    let result: Element | null = null;
    if (data) {
      data = Base.resolveURL(data, xmldoc.url);
      let mediaType = srcElem.getAttribute("media-type");
      if (!mediaType) {
        const path = this.opf.getPathFromURL(data);
        if (path) {
          const item = this.opf.itemMapByPath[path];
          if (item) {
            mediaType = item.mediaType;
          }
        }
      }
      if (mediaType) {
        const handlerSrc = this.opf.bindings[mediaType];
        if (handlerSrc) {
          result = this.viewport.document.createElement("iframe");
          (result as HTMLElement).style.border = "none";
          const srcParam = Base.lightURLEncode(data);
          const typeParam = Base.lightURLEncode(mediaType);
          const sb = new Base.StringBuffer();
          sb.append(handlerSrc);
          sb.append("?src=");
          sb.append(srcParam);
          sb.append("&type=");
          sb.append(typeParam);
          for (let c: Node = srcElem.firstChild; c; c = c.nextSibling) {
            if (c.nodeType == 1) {
              const ce = c as Element;
              if (ce.localName == "param" && ce.namespaceURI == Base.NS.XHTML) {
                const pname = ce.getAttribute("name");
                const pvalue = ce.getAttribute("value");
                if (pname && pvalue) {
                  sb.append("&");
                  sb.append(encodeURIComponent(pname));
                  sb.append("=");
                  sb.append(encodeURIComponent(pvalue));
                }
              }
            }
          }
          result.setAttribute("src", sb.toString());
          const width = srcElem.getAttribute("width");
          if (width) {
            result.setAttribute("width", width);
          }
          const height = srcElem.getAttribute("height");
          if (height) {
            result.setAttribute("height", height);
          }
        }
      }
    }
    if (!result) {
      result = this.viewport.document.createElement("span");
      result.setAttribute("data-adapt-process-children", "true");
    }

    // Need to cast because we need {Element}, not {!Element}
    return Task.newResult(result as Element);
  }

  makeMathJaxView(
    xmldoc: XmlDoc.XMLDocHolder,
    srcElem: Element,
    viewParent: Element,
    computedStyle
  ): Task.Result<Element> {
    // See if MathJax installed, use it if it is.
    const hub = getMathJaxHub();
    if (hub) {
      const doc = viewParent.ownerDocument;
      const span = doc.createElement("span");
      viewParent.appendChild(span);
      const clonedMath = doc.importNode(srcElem, true);
      this.resolveURLsInMathML(clonedMath, xmldoc);
      span.appendChild(clonedMath);
      const queue = hub["queue"];
      queue["Push"](["Typeset", hub, span]);
      const frame: Task.Frame<Element> = Task.newFrame("makeMathJaxView");
      const continuation = frame.suspend();
      queue["Push"](() => {
        continuation.schedule(span);
      });
      return frame.result();
    }
    return Task.newResult(null as Element);
  }

  private resolveURLsInMathML(node: Node, xmldoc: XmlDoc.XMLDocHolder) {
    if (node == null) {
      return;
    }
    if (node.nodeType === 1 && (node as Element).tagName === "mglyph") {
      const attrs = (node as Element).attributes;
      for (const attr of attrs) {
        if (attr.name !== "src") {
          continue;
        }
        const newUrl = Base.resolveURL(attr.nodeValue, xmldoc.url);
        if (attr.namespaceURI) {
          (node as Element).setAttributeNS(
            attr.namespaceURI,
            attr.name,
            newUrl
          );
        } else {
          (node as Element).setAttribute(attr.name, newUrl);
        }
      }
    }
    if (node.firstChild) {
      this.resolveURLsInMathML(node.firstChild, xmldoc);
    }
    if (node.nextSibling) {
      this.resolveURLsInMathML(node.nextSibling, xmldoc);
    }
  }

  // TODO move makeSSEView to a more appropriate class (SSE XML content is not
  // allowed in EPUB)
  /**
   * @param computedStyle
   */
  makeSSEView(
    xmldoc: XmlDoc.XMLDocHolder,
    srcElem: Element,
    viewParent: Element,
    computedStyle
  ): Task.Result<Element> {
    const doc = viewParent ? viewParent.ownerDocument : this.viewport.document;
    const srcTagName = srcElem.localName;
    let tagName;
    switch (srcTagName) {
      case "t":
      case "tab":
      case "ec":
      case "nt":
      case "fraction":
      case "comment":
      case "mark":
        tagName = "span";
        break;
      case "ruby":
      case "rp":
      case "rt":
        tagName = srcTagName;
        break;
      default:
        tagName = "div";
    }
    const result = doc.createElement(tagName);
    result.setAttribute("data-adapt-process-children", "true");

    // Need to cast because we need {Element}, not {!Element}
    return Task.newResult(result as Element);
  }

  /**
   * @override
   */
  makeCustomRenderer(xmldoc: XmlDoc.XMLDocHolder): Vgen.CustomRenderer {
    const self = this;
    return (
      srcElem: Element,
      viewParent: Element,
      computedStyle
    ): Task.Result<Element> => {
      if (
        srcElem.localName == "object" &&
        srcElem.namespaceURI == Base.NS.XHTML
      ) {
        return self.makeObjectView(xmldoc, srcElem, viewParent, computedStyle);
      } else if (srcElem.namespaceURI == Base.NS.MATHML) {
        return self.makeMathJaxView(xmldoc, srcElem, viewParent, computedStyle);
      } else if (srcElem.namespaceURI == Base.NS.SSE) {
        return self.makeSSEView(xmldoc, srcElem, viewParent, computedStyle);
      } else if (
        (srcElem as HTMLElement).dataset &&
        (srcElem as HTMLElement).dataset["mathTypeset"] == "true"
      ) {
        return self.makeMathJaxView(xmldoc, srcElem, viewParent, computedStyle);
      }
      return Task.newResult(null as Element);
    };
  }

  getPageViewItem(spineIndex: number): Task.Result<OPFViewItem> {
    const self = this;
    if (spineIndex === -1 || spineIndex >= self.opf.spine.length) {
      return Task.newResult(null as OPFViewItem);
    }
    let viewItem = self.spineItems[spineIndex];
    if (viewItem) {
      return Task.newResult(viewItem);
    }
    const frame: Task.Frame<OPFViewItem> = Task.newFrame("getPageViewItem");

    // If loading for the item has already been started, suspend and wait for
    // the result.
    let loadingContinuations = this.spineItemLoadingContinuations[spineIndex];
    if (loadingContinuations) {
      const cont = frame.suspend();
      loadingContinuations.push(cont);
      return frame.result();
    } else {
      loadingContinuations = this.spineItemLoadingContinuations[
        spineIndex
      ] = [];
    }
    const item = self.opf.spine[spineIndex];
    const store = self.opf.store;
    store.load(item.src).then((xmldoc: XmlDoc.XMLDocHolder) => {
      item.title = xmldoc.document.title;
      const style = store.getStyleForDoc(xmldoc);
      const customRenderer = self.makeCustomRenderer(xmldoc);
      let viewport = self.viewport;
      const viewportSize = style.sizeViewport(
        viewport.width,
        viewport.height,
        viewport.fontSize,
        self.pref
      );
      if (
        viewportSize.width != viewport.width ||
        viewportSize.height != viewport.height ||
        viewportSize.fontSize != viewport.fontSize
      ) {
        viewport = new Vgen.Viewport(
          viewport.window,
          viewportSize.fontSize,
          viewport.root,
          viewportSize.width,
          viewportSize.height
        );
      }
      const previousViewItem = self.spineItems[spineIndex - 1];
      let pageNumberOffset;
      if (item.startPage !== null) {
        pageNumberOffset = item.startPage - 1;
      } else {
        if (
          spineIndex > 0 &&
          (!previousViewItem || !previousViewItem.complete)
        ) {
          // When navigate to a new spine item skipping the previous items,
          // give up calculate pageNumberOffset and use epage (or spineIndex if epage is unset).
          pageNumberOffset = item.epage || spineIndex;
          if (!self.opf.prePaginated && pageNumberOffset % 2 == 0) {
            // Force to odd number to avoid unpaired page. (This is 0 based and even number is recto)
            pageNumberOffset++;
          }
        } else {
          pageNumberOffset = previousViewItem
            ? previousViewItem.instance.pageNumberOffset +
              previousViewItem.pages.length
            : 0;
        }
        if (item.skipPagesBefore !== null) {
          pageNumberOffset += item.skipPagesBefore;
        }
      }
      self.counterStore.forceSetPageCounter(pageNumberOffset);
      const instance = new Ops.StyleInstance(
        style,
        xmldoc,
        self.opf.lang,
        viewport,
        self.clientLayout,
        self.fontMapper,
        customRenderer,
        self.opf.fallbackMap,
        pageNumberOffset,
        self.opf.documentURLTransformer,
        self.counterStore,
        self.opf.pageProgression
      );
      instance.pref = self.pref;

      // For env(pub-title) and env(doc-title)
      const pubTitles = self.opf.metadata && self.opf.metadata[metaTerms.title];
      instance.pubTitle =
        (pubTitles && pubTitles[0] && pubTitles[0]["v"]) || "";
      instance.docTitle = item.title || "";

      instance.init().then(() => {
        viewItem = {
          item,
          xmldoc,
          instance,
          layoutPositions: [null],
          pages: [],
          complete: false
        };
        self.spineItems[spineIndex] = viewItem;
        frame.finish(viewItem);
        loadingContinuations.forEach(c => {
          c.schedule(viewItem);
        });
      });
    });
    return frame.result();
  }

  removeRenderedPages() {
    const items = this.spineItems;
    for (const item of items) {
      if (item) {
        item.pages.splice(0);
      }
    }
    this.viewport.clear();
  }

  /**
   * Returns if at least one page has 'auto' size
   */
  hasAutoSizedPages(): boolean {
    const items = this.spineItems;
    for (const item of items) {
      if (item) {
        const pages = item.pages;
        for (const page of pages) {
          if (page.isAutoPageWidth && page.isAutoPageHeight) {
            return true;
          }
        }
      }
    }
    return false;
  }

  hasPages(): boolean {
    return this.spineItems.some(item => item && item.pages.length > 0);
  }

  showTOC(autohide: boolean): Task.Result<Vtree.Page> {
    const opf = this.opf;
    const toc = opf.xhtmlToc || opf.ncxToc;
    this.tocAutohide = autohide;
    if (!toc) {
      return Task.newResult(null as Vtree.Page);
    }
    if (this.tocView && this.tocView.page) {
      this.tocView.page.container.style.visibility = "visible";
      this.tocView.page.container.setAttribute("aria-hidden", "false");
      return Task.newResult(this.tocView.page);
    }
    const frame: Task.Frame<Vtree.Page> = Task.newFrame("showTOC");
    if (!this.tocView) {
      this.tocView = new Toc.TOCView(
        opf.store,
        toc.src,
        opf.lang,
        this.clientLayout,
        this.fontMapper,
        this.pref,
        this,
        opf.fallbackMap,
        opf.documentURLTransformer,
        this.counterStore
      );
    }
    const viewport = this.viewport;
    const tocWidth = Math.min(350, Math.round(0.67 * viewport.width) - 16);
    const tocHeight = viewport.height - 6;
    const pageCont = viewport.document.createElement("div") as HTMLElement;
    viewport.root.appendChild(pageCont);
    // pageCont.style.position = "absolute";
    pageCont.style.visibility = "hidden";
    // pageCont.style.left = "3px";
    // pageCont.style.top = "3px";
    pageCont.style.width = `${tocWidth + 10}px`;
    pageCont.style.maxHeight = `${tocHeight}px`;
    // pageCont.style.overflow = "scroll";
    // pageCont.style.overflowX = "hidden";
    // pageCont.style.background = "rgba(248,248,248,0.9)";
    // pageCont.style["borderRadius"] = "2px";
    // pageCont.style["boxShadow"] = "1px 1px 2px rgba(0,0,0,0.4)";

    pageCont.setAttribute("data-vivliostyle-toc-box", "true");
    pageCont.setAttribute("role", "navigation");

    this.tocView
      .showTOC(pageCont, viewport, tocWidth, tocHeight, this.viewport.fontSize)
      .then(page => {
        pageCont.style.visibility = "visible";
        pageCont.setAttribute("aria-hidden", "false");
        frame.finish(page);
      });
    return frame.result();
  }

  hideTOC(): void {
    if (this.tocView) {
      this.tocView.hideTOC();
    }
  }

  isTOCVisible(): boolean {
    return !!this.tocView && this.tocView.isTOCVisible();
  }
}

export interface RenderSinglePageResult {
  pageAndPosition: PageAndPosition;
  nextLayoutPosition: Vtree.LayoutPosition;
}
