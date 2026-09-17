// Lifts the subject out of an image and writes it as a PNG with a transparent background, cropped
// tight to what it found. This is the same subject-lifting macOS uses when you long-press a photo
// in Preview or Photos — Vision's foreground instance mask, on-device, no model to download.
//
// Why this exists: a sticker made by padding a rectangular screenshot into a 512x512 square is just
// a small photo with black bars, which is what "lame" looks like. A real sticker is a die-cut
// subject on transparency. The difference is entirely this step.
//
// Built by scripts/setup-text-extract.sh into state/bin/cutout, alongside extract-text.
//
// Usage:  cutout <input-image> <output.png>
// Exits 1 with a message on stderr if the file cannot be read or no subject is found — "no subject"
// is a normal outcome for a crowd scene or a landscape, not a crash, and the caller should fall
// back to padding rather than treating it as failure.

import AppKit
import CoreImage
import Foundation
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: cutout <input-image> <output.png>") }
let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard FileManager.default.fileExists(atPath: inputURL.path) else { fail("no such file: \(inputURL.path)") }
guard let image = NSImage(contentsOf: inputURL),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("could not decode image: \(inputURL.path)") }

guard #available(macOS 14.0, *) else { fail("subject lifting needs macOS 14 or later") }

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
} catch {
    fail("subject detection failed: \(error.localizedDescription)")
}

guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
    // A crowd, a landscape, or a flat caption card genuinely has no single foreground subject.
    fail("no subject found")
}

do {
    // croppedToInstancesExtent does the tight crop for free — without it the subject keeps the
    // original frame's proportions and the sticker ends up mostly empty space again.
    let masked = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: true
    )
    let ciImage = CIImage(cvPixelBuffer: masked)
    let context = CIContext()
    // RGBA8 rather than the default: the alpha channel is the entire point, and a format without
    // it would silently composite the subject back onto black.
    try context.writePNGRepresentation(
        of: ciImage,
        to: outputURL,
        format: .RGBA8,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!
    )
} catch {
    fail("could not write cutout: \(error.localizedDescription)")
}

let size = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size]) as? Int ?? 0
print("\(outputURL.path) (\(observation.allInstances.count) instance(s), \(size) bytes)")
