const DEFAULT_CONFIG = {
  ssimThreshold: 0.999,
  downsampleWidth: 480,
  downsampleHeight: 270,
}

function convertToGrayscale(imageData) {
  const data = new Uint8ClampedArray(imageData.data)

  for (let index = 0; index < data.length; index += 4) {
    const gray = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2])
    data[index] = gray
    data[index + 1] = gray
    data[index + 2] = gray
  }

  return new ImageData(data, imageData.width, imageData.height)
}

function resizeImageData(imageData, newWidth, newHeight) {
  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height)
  const sourceContext = sourceCanvas.getContext('2d')
  if (!sourceContext) {
    throw new Error('Failed to create source canvas context.')
  }

  sourceContext.putImageData(imageData, 0, 0)

  const targetCanvas = new OffscreenCanvas(newWidth, newHeight)
  const targetContext = targetCanvas.getContext('2d')
  if (!targetContext) {
    throw new Error('Failed to create target canvas context.')
  }

  targetContext.drawImage(sourceCanvas, 0, 0, newWidth, newHeight)
  return targetContext.getImageData(0, 0, newWidth, newHeight)
}

function calculateSsim(imageOne, imageTwo) {
  const grayOne = convertToGrayscale(imageOne)
  const grayTwo = convertToGrayscale(imageTwo)
  const pixelCount = grayOne.width * grayOne.height

  let meanOne = 0
  let meanTwo = 0

  for (let index = 0; index < grayOne.data.length; index += 4) {
    meanOne += grayOne.data[index]
    meanTwo += grayTwo.data[index]
  }

  meanOne /= pixelCount
  meanTwo /= pixelCount

  let varianceOne = 0
  let varianceTwo = 0
  let covariance = 0

  for (let index = 0; index < grayOne.data.length; index += 4) {
    const deltaOne = grayOne.data[index] - meanOne
    const deltaTwo = grayTwo.data[index] - meanTwo
    varianceOne += deltaOne * deltaOne
    varianceTwo += deltaTwo * deltaTwo
    covariance += deltaOne * deltaTwo
  }

  varianceOne /= pixelCount
  varianceTwo /= pixelCount
  covariance /= pixelCount

  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2
  const numerator = (2 * meanOne * meanTwo + c1) * (2 * covariance + c2)
  const denominator = (meanOne * meanOne + meanTwo * meanTwo + c1) * (varianceOne + varianceTwo + c2)
  return numerator / denominator
}

self.onmessage = ({ data }) => {
  const { id, imageOne, imageTwo, config = {} } = data

  try {
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    }

    const preparedImageOne = resizeImageData(imageOne, mergedConfig.downsampleWidth, mergedConfig.downsampleHeight)
    const preparedImageTwo = resizeImageData(imageTwo, mergedConfig.downsampleWidth, mergedConfig.downsampleHeight)
    const ssim = calculateSsim(preparedImageOne, preparedImageTwo)

    self.postMessage({
      id,
      success: true,
      result: {
        changed: ssim < mergedConfig.ssimThreshold,
        ssim,
      },
    })
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown slide comparison error.',
    })
  }
}
