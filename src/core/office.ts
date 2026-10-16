import { SourceError, type Passage } from './extract.js';
import { windowsTask } from './windows.js';

const script = String.raw`
Add-Type -AssemblyName System.IO.Compression
$stream = New-Object IO.MemoryStream(,[Convert]::FromBase64String($inputData.data))
$zip = $null
try {
  $zip = New-Object IO.Compression.ZipArchive($stream)
  if ($zip.Entries.Count -gt 5000) { throw 'office-limit' }
  $total = 0L
  $names = New-Object 'Collections.Generic.HashSet[string]'
  foreach ($entry in $zip.Entries) {
    $total += $entry.Length
    if (!$names.Add($entry.FullName) -or $entry.Length -gt 16777216 -or $total -gt 67108864) { throw 'office-limit' }
  }
  function Read-Xml($name) {
    $entry = $zip.GetEntry($name)
    if (!$entry -or $entry.Length -gt 8388608) { throw 'invalid-office' }
    $settings = New-Object Xml.XmlReaderSettings
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 8388608
    $inputStream = $entry.Open()
    $reader = [Xml.XmlReader]::Create($inputStream, $settings)
    try { $document = New-Object Xml.XmlDocument; $document.XmlResolver = $null; $document.Load($reader); return ,$document }
    finally { $reader.Dispose(); $inputStream.Dispose() }
  }
  function Paragraph-Text($paragraph) {
    $builder = New-Object Text.StringBuilder
    foreach ($node in $paragraph.SelectNodes('.//*[local-name()="t" or local-name()="tab" or local-name()="br"]')) {
      if ($node.LocalName -eq 't') { [void]$builder.Append($node.InnerText) }
      elseif ($node.LocalName -eq 'tab') { [void]$builder.Append([char]9) }
      else { [void]$builder.Append([char]10) }
    }
    return $builder.ToString()
  }
  $blocks = New-Object 'Collections.Generic.List[object]'
  $characters = 0
  if ($inputData.kind -eq '.docx') {
    $document = Read-Xml 'word/document.xml'
    $number = 0
    foreach ($paragraph in $document.SelectNodes('/*[local-name()="document"]/*[local-name()="body"]//*[local-name()="p"]')) {
      $number++; $value = Paragraph-Text $paragraph; $characters += $value.Length
      if ($characters -gt 2000000 -or $number -gt 100000) { throw 'office-limit' }
      if ($value.Trim()) { $blocks.Add(@{ text=$value; paragraph=$number; page=$null }) }
    }
  } else {
    $presentation = Read-Xml 'ppt/presentation.xml'
    $relationships = Read-Xml 'ppt/_rels/presentation.xml.rels'
    $number = 0
    foreach ($slide in $presentation.SelectNodes('/*[local-name()="presentation"]/*[local-name()="sldIdLst"]/*[local-name()="sldId"]')) {
      $number++; if ($number -gt 1000) { throw 'office-limit' }
      $relationId = ($slide.Attributes | Where-Object { $_.LocalName -eq 'id' -and $_.Prefix }).Value
      $relation = @($relationships.DocumentElement.ChildNodes | Where-Object { $_.Id -eq $relationId })
      if ($relation.Count -ne 1 -or $relation[0].TargetMode -eq 'External' -or $relation[0].Target -notmatch '^slides/[^/\\:]+\.xml$') { throw 'invalid-office' }
      $document = Read-Xml ('ppt/' + $relation[0].Target)
      $value = (@($document.SelectNodes('//*[local-name()="p"]') | ForEach-Object { Paragraph-Text $_ }) -join [char]10)
      $characters += $value.Length; if ($characters -gt 2000000) { throw 'office-limit' }
      if ($value.Trim()) { $blocks.Add(@{ text=$value; paragraph=$null; page=$number }) }
    }
  }
  @{ blocks=@($blocks.ToArray()) } | ConvertTo-Json -Depth 4 -Compress
} catch { @{ error=if ($_.Exception.Message -eq 'office-limit') { 'office-limit' } else { 'invalid-office' } } | ConvertTo-Json -Compress }
finally { if ($zip) { $zip.Dispose() }; $stream.Dispose() }
`;

export async function extractOffice(bytes: Buffer, kind: string, signal?: AbortSignal): Promise<Passage[]> {
  const result = await windowsTask(script, { data: bytes.toString('base64'), kind }, signal) as { error?: string; blocks: { text: string; page: number | null; paragraph: number | null }[] };
  if (result.error) throw new SourceError(result.error);
  const passages: Passage[] = [];
  for (const block of result.blocks) for (let offset = 0; offset < block.text.length; offset += 4000) {
    passages.push({ text: block.text.slice(offset, offset + 4000), page: block.page, startLine: block.paragraph, endLine: block.paragraph });
  }
  return passages;
}
