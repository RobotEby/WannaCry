# WannaCry

![Screenshot](https://user-images.githubusercontent.com/46400438/185957528-206dfb47-1397-40bf-ac7b-5686fb693835.gif)

### Features:

1. Change the desktop background

2. Simulate the real `WannaCry` virus interface

3. Rename all files in the `WannaCry.exe` directory (except for the `exe` file) with the extension `.WNCRY`

4. Access `www.iuqerfsodp9ifjaposdfjhgosurijfaewrwergwea.com`

5. Randomly scan port 445 on the `192.168.0.0/16` network segment (will not exploit the `MS17-010` vulnerability)

### Supported Systems:

Tested only on `Windows 7`, `Windows 10`, `Windows Server 2008`, and similar systems

### Usage Instructions:

Place `WannaCry.exe` in an appropriate directory and double-click to run it. You will then be able to monitor access to malicious domains and outbound scans of port 445 on threat intelligence platforms

### Notes:

1. Changing the desktop background uses Windows functions and does not modify the registry

2. Only files in the same directory as `wannacry.exe` will have their extensions changed to `.WNCRY`; files in subdirectories will not be affected

3. `.WNCRY` files are not actually encrypted; the file extension is modified only to simulate encryption. This has no effect on the original file, which can be restored by changing the extension back.

4. Due to external access to malicious domains and scanning of high-risk ports, antivirus software may flag this as a virus...

<br>
<br>
<br>

# Anti_WannaCry

![WeChat Screenshot_20220823213056](https://user-images.githubusercontent.com/46400438/186171652-be3a0f0d-7bc9-41a4-9c48-0ac8a809415e.png)

### Description:

A C# console program used to batch-restore files “encrypted” by `WannaCry.exe` and restore the default `Windows` system wallpaper. The source code is located in the `Anti_WannaCry` folder.

### Usage:

Place `Anti_WannaCry.exe` in the directory you want to restore and double-click to run it. It can only restore files in the current directory.
