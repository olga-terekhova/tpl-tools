$ImageName = "yaz-image:test"
$ContainerName = "yaz-container"
$Connection = "catalogue.symphony.tpl.ca:2200/unicorn"

$dockerCmd = "docker run -it --name $ContainerName --platform linux/amd64 -v ./output:/out $ImageName $Connection"


# Remove old container if it exists

$existing = docker ps -a --filter "name=$ContainerName" --format "{{.ID}}"
if ($existing) {
    Write-Host "Removing existing $ContainerName..."
    docker stop $ContainerName | Out-Null
    docker rm $ContainerName | Out-Null
}

# Check if image exists

if (docker images -q $ImageName) {
    Write-Host "Image '$ImageName' already exists locally."
    
    # Run container
    Invoke-Expression $dockerCmd 

} else {
    Write-Host "Image '$ImageName' not found. You may need to build it first."
}


Write-Host "Finished"