// Text out of an image or a PDF, using only what macOS already ships: Vision for OCR, PDFKit for
// PDFs. Same bargain as the voice pipeline (whisper.cpp, Piper) — entirely on-device, no API key,
// nothing about a message ever leaves the machine.
//
// Built by scripts/setup-text-extract.sh into state/bin/extract-text. Compiled rather than run
// through an interpreter because Vision is a native framework with no stable CLI of its own.
//
// Usage:  extract-text <path> [--langs tr-TR,en-US]
// Prints the extracted text to stdout and exits 0. Exits 1 with a message on stderr if the file
// cannot be read or the type is unsupported; exits 0 with empty output when there is simply no text
// in the file, which is a normal outcome, not an error.

import AppKit
import Foundation
import PDFKit
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Vision rejects the whole request if asked for a language the installed OS doesn't have, so the
// requested set is intersected with what this machine actually supports rather than assumed. A
// Turkish model in particular is not present on every macOS version, and the failure mode without
// this is no OCR at all rather than OCR in the remaining languages.
// The instance method, not the type method: the latter has been deprecated since macOS 12 and
// reports for a revision rather than for the configured request.
func supportedLanguages(_ wanted: [String], on request: VNRecognizeTextRequest) -> [String] {
    let available = (try? request.supportedRecognitionLanguages()) ?? []
    return wanted.filter { available.contains($0) }
}

func ocr(_ url: URL, langs: [String]) -> String {
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { fail("could not decode image: \(url.path)") }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Language correction fixes the kind of OCR noise that matters most here — screenshots of chat
    // and UI text, where a single wrong character makes a word unsearchable.
    request.usesLanguageCorrection = true
    let chosen = supportedLanguages(langs, on: request)
    if !chosen.isEmpty { request.recognitionLanguages = chosen }

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("OCR failed: \(error.localizedDescription)")
    }
    let observations = request.results ?? []
    // One line per observation, in Vision's own order: it returns text blocks roughly top-to-bottom,
    // which keeps a screenshot readable instead of collapsing it into one run-on line.
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func pdfText(_ url: URL) -> String {
    guard let doc = PDFDocument(url: url) else { fail("could not open PDF: \(url.path)") }
    // Embedded text only. A scanned PDF (pages that are images) legitimately yields nothing here —
    // reported as empty rather than as an error, since "no text layer" is a property of the file,
    // not a failure to read it.
    return doc.string ?? ""
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: extract-text <path> [--langs tr-TR,en-US]") }
let path = args[1]

var langs = ["tr-TR", "en-US"]
if let i = args.firstIndex(of: "--langs"), i + 1 < args.count {
    langs = args[i + 1].split(separator: ",").map(String.init)
}

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)") }

let text: String
switch url.pathExtension.lowercased() {
case "pdf":
    text = pdfText(url)
case "jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "heic", "webp":
    text = ocr(url, langs: langs)
default:
    fail("unsupported file type: .\(url.pathExtension)")
}

print(text.trimmingCharacters(in: .whitespacesAndNewlines))
