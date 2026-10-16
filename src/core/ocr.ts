import { SourceError } from './extract.js';
import { windowsTask } from './windows.js';

const script = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ocr = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()
if (!$ocr) { @{ error='ocr-unavailable' } | ConvertTo-Json -Compress; exit }
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' } | Select-Object -First 1)
function Await-WinRT($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (!$task.Wait(15000)) { throw 'ocr-timeout' }
  return $task.Result
}
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object Windows.Storage.Streams.DataWriter($stream)
try {
  $writer.WriteBytes([Convert]::FromBase64String($inputData.data))
  [void](Await-WinRT $writer.StoreAsync() ([uint32]))
  $stream.Seek(0)
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT $decoder.GetSoftwareBitmapAsync() ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'ocr-limit' }
    $result = Await-WinRT $ocr.RecognizeAsync($bitmap) ([Windows.Media.Ocr.OcrResult])
    @{ text=(@($result.Lines | ForEach-Object Text) -join [char]10); language=$ocr.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress
  } finally { $bitmap.Dispose() }
} finally { $writer.Dispose(); $stream.Dispose() }
`;

export async function recognizeImage(png: Buffer, signal?: AbortSignal): Promise<{ text: string; language: string }> {
  try {
    const result = await windowsTask(script, { data: png.toString('base64') }, signal) as { error?: string; text: string; language: string };
    if (result.error || typeof result.text !== 'string') throw new Error(result.error ?? 'ocr-unavailable');
    return result;
  } catch (error) {
    if (signal?.aborted) throw new SourceError('cancelled');
    throw new SourceError(error instanceof Error && error.message === 'native-timeout' ? 'ocr-timeout' : 'ocr-unavailable');
  }
}
