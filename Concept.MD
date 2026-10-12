The Archipelago Controller is a program/app/controller that allows me to perform some actions automatically for hosting and playing Archipelago. It's symbiotic with the Archipelago software.

It'll automatate the following things:
- [] It allows to save game yaml templates in a catogorized way, by creating a subfolder per game and naming the files aptly in the format Gamename_Description.yaml. Such as LinkToThePast_Easy.yaml.
- [] It'll check before generation if the player/slot names for all the yamls are unique, and will append a short code for the game to the end of the player/slot in the yaml if needed. So it might turn Sethiduck into Sethiduck_ALTTP in the slotname.
- [] It will allow generation with all saved yamls, effectively running generation with the selected yamls.
- [] It will allow some minor customization for the host yaml as well, so that doesn't need to be done manually.
- [] It will automatically save the generation by unpacking it into a folder with a smart name.
- [] It'll have a button to host all saved yamls, or to open the archipelago launch site.

Currently the template YAMLs live in c:\ProgramData\Archipelago\Players\Temp\