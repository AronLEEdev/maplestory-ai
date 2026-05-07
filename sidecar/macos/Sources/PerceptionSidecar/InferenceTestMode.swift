// --inference-test mode: load .mlpackage, run N dummy inferences with a
// zero-tensor input, report schema + p50/p95 latency on stderr, exit.
// Validates the model loads and runs on the Neural Engine before
// capture/preprocess/postprocess paths are wired (tasks 5-8).
import Foundation
import CoreML

func runInferenceTestMode(parsed: Args) {
  guard let modelPath = parsed.modelPath else {
    FileHandle.standardError.write("inference-test: --model required\n".data(using: .utf8)!)
    exit(2)
  }

  let infer: Inference
  do {
    infer = try Inference(modelPath: modelPath)
  } catch {
    FileHandle.standardError.write("inference-test: \(error)\n".data(using: .utf8)!)
    exit(1)
  }

  let s = infer.schema
  FileHandle.standardError.write(
    """
    inference-test: model loaded
      input:  \(s.inputName) (\(s.inputType)) shape=\(s.inputShape)
      output: \(s.outputName) (\(s.outputType)) shape=\(s.outputShape)

    """.data(using: .utf8)!
  )

  // Build a zero-input feature provider matching the declared schema.
  let zeroInput: MLFeatureProvider
  do {
    zeroInput = try makeZeroInput(schema: s, modelDescription: infer.model.modelDescription)
  } catch {
    FileHandle.standardError.write("inference-test: build zero input failed: \(error)\n".data(using: .utf8)!)
    exit(1)
  }

  let total = parsed.inferenceTestIters
  let warmup = min(5, total / 4)
  var ms: [Double] = []
  ms.reserveCapacity(total)
  FileHandle.standardError.write(
    "inference-test: running \(total) iters (\(warmup) warmup)\n".data(using: .utf8)!
  )

  for i in 0..<total {
    let t0 = Date()
    do {
      _ = try infer.predict(zeroInput)
    } catch {
      FileHandle.standardError.write("inference-test: predict failed at iter \(i): \(error)\n".data(using: .utf8)!)
      exit(1)
    }
    let dt = Date().timeIntervalSince(t0) * 1000
    if i >= warmup { ms.append(dt) }
  }

  ms.sort()
  let n = ms.count
  let avg = ms.reduce(0, +) / Double(n)
  let p50 = ms[n / 2]
  let p95 = ms[min(n - 1, Int(Double(n) * 0.95))]
  let p99 = ms[min(n - 1, Int(Double(n) * 0.99))]
  let throughput = 1000 / avg
  FileHandle.standardError.write(
    String(
      format: """
        inference-test: %d iters (post-warmup)
          avg=%.2fms p50=%.2fms p95=%.2fms p99=%.2fms
          throughput: ~%.1f FPS
        """,
      n, avg, p50, p95, p99, throughput
    ).data(using: .utf8)! + "\n".data(using: .utf8)!
  )
  exit(0)
}

/// Build a feature provider whose single input is a zeroed array/image
/// matching the model's declared input shape. Works for both
/// multiArray and image inputs.
private func makeZeroInput(
  schema: ModelSchema,
  modelDescription: MLModelDescription
) throws -> MLFeatureProvider {
  guard let desc = modelDescription.inputDescriptionsByName[schema.inputName] else {
    throw InferenceError.missingInput(schema.inputName)
  }
  switch desc.type {
  case .image:
    guard let imgC = desc.imageConstraint else {
      throw InferenceError.missingInput("image constraint")
    }
    let w = Int(truncatingIfNeeded: imgC.pixelsWide)
    let h = Int(truncatingIfNeeded: imgC.pixelsHigh)
    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
    let st = CVPixelBufferCreate(
      kCFAllocatorDefault, w, h,
      imgC.pixelFormatType,
      attrs as CFDictionary,
      &pb
    )
    guard st == kCVReturnSuccess, let buf = pb else {
      throw InferenceError.predictFailed("CVPixelBufferCreate \(st)")
    }
    return try MLDictionaryFeatureProvider(dictionary: [
      schema.inputName: MLFeatureValue(pixelBuffer: buf)
    ])
  case .multiArray:
    guard let aC = desc.multiArrayConstraint else {
      throw InferenceError.missingInput("multiArray constraint")
    }
    let arr = try MLMultiArray(shape: aC.shape, dataType: aC.dataType)
    // shape product
    var n = 1
    for d in aC.shape { n *= d.intValue }
    // zero-fill — MLMultiArray init does not guarantee zeros.
    let ptr = arr.dataPointer
    switch aC.dataType {
    case .float32: memset(ptr, 0, n * MemoryLayout<Float>.size)
    case .float16: memset(ptr, 0, n * 2)
    case .double:  memset(ptr, 0, n * MemoryLayout<Double>.size)
    case .int32:   memset(ptr, 0, n * MemoryLayout<Int32>.size)
    @unknown default: memset(ptr, 0, n * 4)
    }
    return try MLDictionaryFeatureProvider(dictionary: [
      schema.inputName: MLFeatureValue(multiArray: arr)
    ])
  default:
    throw InferenceError.predictFailed("unsupported input type \(schema.inputType)")
  }
}
