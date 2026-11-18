#requires -Version 7.2
function Export-PublicConfigBuilder([string]$InputFile,[string]$OutputFile){
 $html=[IO.File]::ReadAllText($InputFile)
 $pattern='<img\b(?=[^>]*\bid="template-artwork")[^>]*>'
 $matches=[regex]::Matches($html,$pattern,[Text.RegularExpressions.RegexOptions]::Singleline)
 if($matches.Count -eq 1){
  $original='<svg class="template-artwork" id="template-artwork" data-original-illustration="true" viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="12" fill="#edf2e8"/><path d="M15 17h18M15 31h18M24 17v14" fill="none" stroke="#3f4b39" stroke-width="2"/><circle cx="15" cy="17" r="4" fill="#ffffff" stroke="#3f4b39" stroke-width="2"/><circle cx="33" cy="17" r="4" fill="#ffffff" stroke="#3f4b39" stroke-width="2"/><circle cx="24" cy="31" r="4" fill="#ffffff" stroke="#3f4b39" stroke-width="2"/></svg>'
  $html=[regex]::Replace($html,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($match)$original},[Text.RegularExpressions.RegexOptions]::Singleline)
 }elseif($matches.Count -ne 0 -or -not $html.Contains('data-original-illustration="true"')){throw 'The public artwork export selector changed. Review it before shipping borrowed document artwork.'}
 [IO.File]::WriteAllText($OutputFile,$html)
}
