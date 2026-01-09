$ImageName = "yaz-image:test"
$dockerCmd = "docker buildx build --platform linux/amd64 --provenance=false -t $ImageName ."
Invoke-Expression  $dockerCmd

Write-Host "Finished"
