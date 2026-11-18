#requires -Version 7.2
param([ValidateSet('all','profiles','platform','interface','onboarding','browser','people','content','knowledge','packs','prerequisites','installer')][string]$Phase='all')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$node=Get-Command node.exe -CommandType Application -ErrorAction Stop
$selectors=@(switch($Phase){
 'profiles' {@('.\tests\profiles.test.cjs')}
 'platform' {@('.\tests\platform.test.cjs','.\tests\azure-cli.test.cjs')}
 'interface' {@('.\tests\server.test.cjs')}
 'onboarding' {@('.\tests\onboarding.test.cjs','.\tests\browser.test.cjs')}
 'browser' {@('.\tests\browser.test.cjs')}
 'people' {@('.\tests\people.test.cjs')}
 'content' {@('.\tests\content.test.cjs')}
 'knowledge' {@('.\tests\knowledge.test.cjs')}
 'packs' {@('.\tests\knowledge-pack.test.cjs')}
 'prerequisites' {@('.\tests\prerequisites.test.cjs')}
 'installer' {@('.\tests\installer.test.cjs','.\tests\installer-readiness.test.cjs','.\tests\runtime-owner.test.cjs','.\tests\source-package.test.cjs','.\tests\prerequisites.test.cjs')}
 'all' {@('.\tests\profiles.test.cjs','.\tests\platform.test.cjs','.\tests\azure-cli.test.cjs','.\tests\server.test.cjs','.\tests\onboarding.test.cjs','.\tests\browser.test.cjs','.\tests\people.test.cjs','.\tests\content.test.cjs','.\tests\knowledge.test.cjs','.\tests\knowledge-pack.test.cjs','.\tests\installer.test.cjs','.\tests\installer-readiness.test.cjs','.\tests\runtime-owner.test.cjs','.\tests\source-package.test.cjs','.\tests\prerequisites.test.cjs')}
})
Push-Location -LiteralPath $root
try { & $node.Source --test --test-concurrency=2 @selectors; if($LASTEXITCODE -ne 0){throw 'DemoSeeder tests failed.'} }
finally { Pop-Location }
